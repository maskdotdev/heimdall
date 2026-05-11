# Review Worker

The review worker owns LLM and review-quality logic.

Expected ownership:

- Prompting.
- Model calls.
- Context packing.
- Structured output validation.
- Finding ranking.
- Finding deduplication.
- Review-standard extraction.
- Review-quality telemetry.

Do not publish provider comments from this worker. Publishing belongs in `workers/publisher`.
