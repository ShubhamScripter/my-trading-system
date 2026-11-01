CREATE TABLE identity.rate_limit_policy_versions (
  id uuid PRIMARY KEY,
  version integer NOT NULL UNIQUE,
  policy jsonb NOT NULL,
  actor varchar(128) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_rate_limit_policy_versions_active
  ON identity.rate_limit_policy_versions (active, version DESC);
