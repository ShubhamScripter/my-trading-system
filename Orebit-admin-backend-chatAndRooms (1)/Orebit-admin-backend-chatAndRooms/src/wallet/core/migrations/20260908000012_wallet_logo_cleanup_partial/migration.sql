BEGIN;

ALTER TYPE wallet_core."WalletCronSafeReasonCode" ADD VALUE 'LOGO_CLEANUP_PARTIAL';

-- Compare the new enum label as text so it is not consumed before this transaction commits.
-- Existing status/reason and separate lease/count/catch-up constraints remain intact.
ALTER TABLE wallet_core.cronjob_runs DROP CONSTRAINT cronjob_runs_status_reason;
ALTER TABLE wallet_core.cronjob_runs ADD CONSTRAINT cronjob_runs_status_reason CHECK (
  (status IN ('RUNNING','SUCCESS') AND safe_error_code IS NULL)
  OR (status='PARTIAL' AND safe_error_code IS NOT NULL AND safe_error_code::text IN (
    'CONFIGURATION_REJECTED','PROVIDER_OBSERVATION_PARTIAL','LIFECYCLE_PARTIAL','RECONCILIATION_PARTIAL'))
  OR (status='PARTIAL' AND safe_error_code IS NOT NULL AND safe_error_code::text='LOGO_CLEANUP_PARTIAL'
    AND job_name='wallet-logo-cleanup' AND failed_count>0)
  OR (status='FAILED' AND safe_error_code IS NOT NULL AND safe_error_code::text IN (
    'PROVIDER_OBSERVATION_FAILED','DEPENDENCY_UNAVAILABLE','UNEXPECTED_ERROR'))
  OR (status='SKIPPED' AND safe_error_code IS NOT NULL AND safe_error_code::text IN (
    'MISSED_SCHEDULE','CATCHUP_TRUNCATED')));

COMMIT;
