# Working rules for this project
1. When working on an uploaded project zip, always deliver the updated zip at the end of the session (before tokens run out).
2. Never report a check as passed unless it was actually executed; label NOT RUN / SKIPPED explicitly.
3. Update HANDOFF.md and docs/test-report-*.md with exact results every session.
4. Concurrency claims need a test that fails when the lock/transaction is removed (mutation-check it and record the result).
