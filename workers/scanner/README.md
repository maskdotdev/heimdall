# Scanner Worker

The scanner worker owns deterministic static-analysis tools.

Expected ownership:

- Semgrep.
- CodeQL when enabled.
- Secret scanning.
- Scanner rulesets.
- Scanner output parsing.
- Scanner finding normalization.
- Conversion from scanner findings to review signals.

Scanner output is still untrusted input to the review system. Normalize and validate it before it affects persisted findings or provider comments.
