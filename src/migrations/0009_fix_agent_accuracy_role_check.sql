-- ============================================================================
-- U-I-OS Migration 0009 — fix agent_accuracy.agent_role CHECK constraint
-- ============================================================================
-- Migration 0008 added the 'data_cleaner' role to agent_runs.role and
-- proposed_actions.kind, but missed agent_accuracy.agent_role. Result:
-- approveAction()/rejectAction() silently fail to write agent_accuracy rows
-- for data_cleaner proposals (the write is wrapped in try/catch so the
-- approval/rejection itself still succeeds, but accuracy tracking is lost).
-- Run once against the same DB as 0008.
-- ============================================================================

alter table agent_accuracy drop constraint if exists agent_accuracy_agent_role_check;
alter table agent_accuracy add constraint agent_accuracy_agent_role_check
  check (agent_role in ('accountant','analyst','anomaly_detector','categorizer','data_cleaner'));
