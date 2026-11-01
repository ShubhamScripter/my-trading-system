function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacementRules(from, to) {
  const token = escaped(from);
  return [
    [new RegExp(`\\b${token}\\b(?=\\s*\\.)`, 'g'), to],
    [new RegExp(`(\\bSCHEMA(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+)${token}\\b`, 'gi'),
      `$1${to}`],
    [new RegExp(`(\\bsearch_path\\s*=\\s*pg_catalog\\s*,\\s*)${token}\\b`, 'gi'),
      `$1${to}`],
  ];
}

function mapCode(code, from, to) {
  let mapped = code;
  for (const [pattern, replacement] of replacementRules(from, to)) {
    mapped = mapped.replace(pattern, replacement);
  }
  return mapped;
}

function quotedEnd(sql, start, quote) {
  const escapeString = quote === "'" && start > 0 && /[eE]/.test(sql[start - 1])
    && (start === 1 || !/[A-Za-z0-9_$]/.test(sql[start - 2]));
  for (let index = start + 1; index < sql.length; index += 1) {
    if (escapeString && sql[index] === '\\') { index += 1; continue; }
    if (sql[index] !== quote) continue;
    if (sql[index + 1] === quote) { index += 1; continue; }
    return index + 1;
  }
  throw new Error('SQL contains an unterminated quoted token');
}

function blockCommentEnd(sql, start) {
  let depth = 1;
  for (let index = start + 2; index < sql.length - 1; index += 1) {
    if (sql.startsWith('/*', index)) { depth += 1; index += 1; }
    else if (sql.startsWith('*/', index) && --depth === 0) return index + 2;
  }
  throw new Error('SQL contains an unterminated block comment');
}

function dollarDelimiterAt(sql, index) {
  return /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
}

const hidden = (value) => value.replace(/[^\r\n]/g, ' ');

function codeProjection(sql, visibleQuotedIdentifier) {
  let projected = '';
  let codeStart = 0;
  for (let index = 0; index < sql.length;) {
    let end;
    if (sql.startsWith('--', index)) {
      projected += sql.slice(codeStart, index);
      const newline = sql.indexOf('\n', index + 2);
      end = newline < 0 ? sql.length : newline + 1;
      projected += hidden(sql.slice(index, end));
    } else if (sql.startsWith('/*', index)) {
      projected += sql.slice(codeStart, index);
      end = blockCommentEnd(sql, index);
      projected += hidden(sql.slice(index, end));
    } else if (sql[index] === "'") {
      projected += sql.slice(codeStart, index);
      end = quotedEnd(sql, index, "'");
      projected += hidden(sql.slice(index, end));
    } else if (sql[index] === '"') {
      projected += sql.slice(codeStart, index);
      end = quotedEnd(sql, index, '"');
      const raw = sql.slice(index, end);
      const identifier = raw.slice(1, -1).replace(/""/g, '"');
      projected += identifier === visibleQuotedIdentifier ? raw : hidden(raw);
    } else {
      const delimiter = sql[index] === '$' ? dollarDelimiterAt(sql, index) : undefined;
      if (!delimiter) { index += 1; continue; }
      projected += sql.slice(codeStart, index) + hidden(delimiter);
      const close = sql.indexOf(delimiter, index + delimiter.length);
      if (close < 0) throw new Error('SQL contains an unterminated dollar-quoted body');
      projected += codeProjection(
        sql.slice(index + delimiter.length, close), visibleQuotedIdentifier,
      ) + hidden(delimiter);
      end = close + delimiter.length;
    }
    index = end;
    codeStart = end;
  }
  return projected + sql.slice(codeStart);
}

function applySchemaRules(sql, from, to) {
  let mapped = '';
  let codeStart = 0;
  for (let index = 0; index < sql.length;) {
    let end;
    let protectedText;
    if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index + 2);
      end = newline < 0 ? sql.length : newline + 1;
      protectedText = sql.slice(index, end);
    } else if (sql.startsWith('/*', index)) {
      end = blockCommentEnd(sql, index);
      protectedText = sql.slice(index, end);
    } else if (sql[index] === "'") {
      end = quotedEnd(sql, index, "'");
      protectedText = sql.slice(index, end);
    } else if (sql[index] === '"') {
      end = quotedEnd(sql, index, '"');
      const raw = sql.slice(index, end);
      const identifier = raw.slice(1, -1).replace(/""/g, '"');
      const prefix = identifier === from ? codeProjection(sql.slice(0, index)) : '';
      const schemaContext = /\bSCHEMA(?:\s+IF\s+NOT\s+EXISTS)?\s*$/i.test(prefix);
      const searchPathContext = /\bsearch_path\s*(?:=|TO)[^;]*$/i.test(prefix);
      protectedText = identifier === from && (/^\s*\./.test(sql.slice(end))
        || schemaContext || searchPathContext)
        ? `"${to.replace(/"/g, '""')}"` : raw;
    } else {
      const delimiter = sql[index] === '$' ? dollarDelimiterAt(sql, index) : undefined;
      if (!delimiter) { index += 1; continue; }
      const close = sql.indexOf(delimiter, index + delimiter.length);
      if (close < 0) throw new Error('SQL contains an unterminated dollar-quoted body');
      end = close + delimiter.length;
      protectedText = delimiter
        + applySchemaRules(sql.slice(index + delimiter.length, close), from, to) + delimiter;
    }
    mapped += mapCode(sql.slice(codeStart, index), from, to) + protectedText;
    index = end;
    codeStart = end;
  }
  return mapped + mapCode(sql.slice(codeStart), from, to);
}

function hasSchemaTarget(sql, schema) {
  const code = codeProjection(sql, schema);
  const token = escaped(schema);
  const identifier = `(?:\\b${token}\\b|"${escaped(schema.replace(/"/g, '""'))}")`;
  return new RegExp(`${identifier}\\s*\\.`, 'i').test(code)
    || new RegExp(`\\bSCHEMA(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${identifier}(?=\\s|,|;|$)`, 'i').test(code)
    || new RegExp(`\\bsearch_path\\s*(?:=|TO)[^;]*${identifier}(?=\\s|,|;|$)`, 'i').test(code);
}

function verifyMappedSql(source, mapped, from, to) {
  if (source === mapped || applySchemaRules(mapped, to, from) !== source) {
    throw new Error(`Schema mapping ${from} to ${to} changed non-schema SQL`);
  }
  if (hasSchemaTarget(mapped, from)) {
    throw new Error(`Schema mapping left a production ${from} target`);
  }
}

function mapSchemaIdentifiers(sql, from, to) {
  const mapped = applySchemaRules(sql, from, to);
  verifyMappedSql(sql, mapped, from, to);
  return mapped;
}

function assertMappedSql(sql) {
  for (const schema of ['admin', 'price_conversion', 'wallet_core']) {
    if (hasSchemaTarget(sql, schema)) {
      throw new Error(`Mapped SQL still targets production schema ${schema}`);
    }
  }
}

module.exports = { mapSchemaIdentifiers, verifyMappedSql, assertMappedSql, hasSchemaTarget };
