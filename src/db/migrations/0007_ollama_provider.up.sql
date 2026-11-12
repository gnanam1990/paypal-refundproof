-- 0007 real local AI provider. Ollama runs on loopback and returns the same schema-constrained proposal envelope.
alter table model_invocations drop constraint model_invocations_provider_check;
alter table model_invocations add constraint model_invocations_provider_check
  check (provider in ('anthropic', 'ollama', 'local-fixture'));
