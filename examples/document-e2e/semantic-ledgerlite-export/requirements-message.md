I'm planning a small offline CLI command, `ledgerlite export`, and later in this session I will ask you for its design note. These are my requirements for it:

1. The export format is CSV only. JSON export is out of scope for this release.
2. Amounts are stored and exported as integer cents. Never convert amounts to floating point.
3. Dates in the CSV are ISO 8601 calendar dates (YYYY-MM-DD) in UTC.
4. The command runs fully offline: no network access of any kind, no telemetry and no update checks.
5. If the output file already exists, refuse to write it and exit with code 2, unless `--force` is given.
6. Rows are sorted by transaction date ascending, then by transaction id ascending.
7. The personal `note` field is excluded by default; `--include-notes` adds it as the last column.
8. Exit codes: 0 on success, 1 on invalid input data, 2 on output conflicts.

Do not use any tools and do not create any files yet. Reply only with "Noted".
