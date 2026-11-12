-- Rollback refuses while Ollama invocation evidence exists; invocation rows are append-only by design.
do $$
begin
  if exists (select 1 from model_invocations where provider = 'ollama') then
    raise exception 'refundproof: cannot remove Ollama provider while Ollama invocations exist' using errcode = '55000';
  end if;
end $$;
alter table model_invocations drop constraint model_invocations_provider_check;
alter table model_invocations add constraint model_invocations_provider_check
  check (provider in ('anthropic', 'local-fixture'));
