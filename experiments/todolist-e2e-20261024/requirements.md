# Offline Python TodoList contract

Implement `todo.py` from scratch using Python 3.9+ and only the standard library.
This is a sequential local CLI, with one fresh Python process per command and
persistent JSON storage selected by `--store PATH`.

Commands: `list`, `add TITLE`, `rename ID TITLE`, `complete ID`, `reopen ID`,
and `delete ID`. Successful commands exit 0 and emit valid JSON to stdout.
Items have exactly `id` (positive integer), `title` (Unicode string), and
`completed` (boolean). New items start incomplete; IDs increase and are never
reused after deletion. List returns an array. Add/rename/complete/reopen return
the affected item. An absent store lists as [] without creating a file.

Reject empty or whitespace-only titles and nonexistent IDs with exit 1,
an explanatory stderr message, and no mutation of existing storage bytes.
Create missing parent directories when writing. Persist atomically using a
temporary file, file synchronization (`fsync`), and `os.replace`; leave no
`.todo-*` temporary files after successful or rejected commands.

Mutations optionally accept `--operation-id ID` before the command. Repeating
the same operation ID with the same command and arguments returns its original
immutable JSON receipt without repeating the mutation. Reusing an operation ID
for different inputs exits 1 without modifying the store. Receipts survive
separate processes and later edits to the item.

Frozen acceptance comprises the unchanged nine cases in `test_todo.py` plus
one connected same-store journey: Unicode add → list → rename → complete →
reopen → delete → empty list. Run `acceptance/verify_todolist.py --project PATH`.
It must exit 0 and print `TODOLIST_VERIFIED` before claiming verified completion.
The verifier records the source hash and actual CLI results.

Only create/modify `todo.py` and project-local application data. Preserve this
contract, tests, acceptance verifier, and corrector configuration. Do not copy
an implementation from another project, install dependencies, or access the
network for application development. Running the frozen tests/verifier is
explicitly allowed to create and clean its own isolated TemporaryDirectory
outside the project under this run's configured TEMP. No UI or web server is
required. Documentation correction and Skill correction are disabled for this
experiment; final Stop and implementation review remain enabled.
