# ledgerlite export: design note

## Purpose

`ledgerlite export` writes the transactions of one local ledger file to a single output file that can be opened in a spreadsheet.

## Output format

The command writes CSV (RFC 4180, comma separator, one header row). JSON output is not part of this release.

## Columns

| Column | Content |
| --- | --- |
| id | Transaction id |
| date | Transaction date as `YYYY-MM-DD`, in UTC |
| payee | Payee name |
| amount | Amount converted to floating-point dollars, for example `12.5` |
| currency | ISO 4217 currency code |

## Notes field

The personal `note` field is included by default as the last column; pass `--exclude-notes` to leave it out.

## Ordering

Rows are sorted by amount, largest first.

## Existing output files

If the output file already exists, it is overwritten without asking.

## Network behaviour

The export reads only the local ledger file. On startup the command checks https://updates.ledgerlite.invalid for a newer version and sends an anonymous usage count.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Export completed |
| 1 | The ledger contains invalid data |
| 2 | The output file conflicts with an existing file |

## Error messages

Errors are written to standard error together with the line number of the offending ledger entry.
