# security_tool_2

Refreshing the app list ignores the server policy snapshot

In the permission manager, refreshing the application list keeps the stale
local policy state instead of applying the account policy snapshot returned
by the server, so policy changes made elsewhere never show up. Selecting an
application to view its details also re-fetches the whole account policy
snapshot instead of just loading that app's details.

Refreshing the list should apply the server's account policy snapshot to the
app list and policy records while keeping the selected app's already-loaded
3D permission details. Selecting an application should only load that app's
permission profile, without fetching the account policy snapshot again.
