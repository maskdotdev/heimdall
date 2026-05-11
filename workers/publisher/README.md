# Publisher Worker

The publisher worker owns provider comment publishing.

Expected ownership:

- Publishing reviews.
- Publishing inline comments.
- Publishing summary comments.
- Updating existing comments.
- Provider-specific formatting.
- Provider rate limits and backoff.

Do not run LLM review logic in this worker.
