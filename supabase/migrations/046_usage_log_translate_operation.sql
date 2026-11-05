-- 046: Re-file historical translation spend under its own usage_log operation.
--
-- The on-demand translate route (app/api/episodes/[id]/translate) originally
-- logged its OpenAI cost as operation = 'summarize' with metadata.task =
-- 'translate', folding translation into summarization totals on the Usage
-- page / dashboard "last summarize" timestamp. The route now logs
-- operation = 'translate' via lib/usage.ts#logTranslationUsage; this moves the
-- rows written before that change.
--
-- usage_log.operation has no CHECK constraint (free text since migration 001;
-- the allowed set is the TS union UsageLog['operation'] in lib/types.ts), so no
-- constraint change is needed. Idempotent: a re-run matches nothing.

update public.usage_log
   set operation = 'translate'
 where operation = 'summarize'
   and metadata->>'task' = 'translate';
