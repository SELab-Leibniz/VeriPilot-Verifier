# Private review dependencies

`typebox-1.3.27.tgz` is the unmodified npm package from
`https://registry.npmjs.org/typebox/-/typebox-1.3.27.tgz` (MIT).
Its SHA-512 integrity is pinned in `lib/review-task/package-lock.json`.

The OpenClaw builder verifies that integrity and expands the package, including
its license, into the artifact's private `vendor/typebox/` directory. The packaged
review worker imports that exact relative path. Building and installing the
artifact needs no dependency download, global installation, or host TypeBox.

To refresh this archive deliberately, update the worker package and lock together,
then download the matching package with `npm pack typebox@<exact-version>
--pack-destination packaging/vendor --ignore-scripts`. The build rejects a missing,
changed or mismatched archive instead of silently using another installation.
