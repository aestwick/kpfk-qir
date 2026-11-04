// Retry-policy helpers shared by the processing workers.
//
// A spend-limit / billing block is an *organization-wide* condition, not a
// problem with the episode being processed. Counting it toward the 3-strikes
// rule wrongly burns an episode's retry budget and eventually marks healthy
// episodes 'dead' — so a single billing outage can kill a whole backlog.
// These failures should keep an episode retryable indefinitely: once billing
// is restored, auto-retry resets it to 'pending' and it processes normally.
export function isSpendLimitError(message: string | null | undefined): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return (
    m.includes('spend_limit_reached') ||
    m.includes('spend alert threshold') ||
    m.includes('blocked api access because') ||
    // Provider billing lapses (Deepgram 402 ASR_PAYMENT_REQUIRED / out of
    // credits): three of these in a row killed healthy episodes on 7/21.
    m.includes('asr_payment_required') ||
    m.includes('payment required') ||
    m.includes('insufficient credits') ||
    m.includes('not have enough credits')
  )
}
