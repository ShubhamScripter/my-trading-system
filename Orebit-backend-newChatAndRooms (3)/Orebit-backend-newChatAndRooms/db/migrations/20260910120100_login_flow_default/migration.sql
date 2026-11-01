-- The second half of 20260910120000_login_flow.
--
-- Separate file, and only because Postgres will not let a transaction use an
-- enum value it added itself. The previous migration added 'STARTED' and
-- 'OTP_SENT'; this one makes 'STARTED' the default for new rows, which is the
-- state `POST /auth/login {step:'start'}` opens a flow in.
--
-- The old default was 'FACTOR_REQUIRED', which was right when a row was only ever
-- created after a first factor had succeeded. A row created in that state now
-- would be a sign-in that had proven nothing and was owed only its SECOND factor
-- — the exact bypass the state machine exists to prevent — so leaving the default
-- behind would be leaving a loaded footgun for any future insert that omits the
-- column.
ALTER TABLE "identity"."login_attempts"
  ALTER COLUMN "state" SET DEFAULT 'STARTED';
