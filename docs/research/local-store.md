# The local store — checked 2026-10-14

What `local-store` runs, and why ([ADR 0020](../../adr/0020-local-state-lives-in-a-shared-local-store.md)).

**LocalStack** (2026-10-14): since 2026-03-23 its one image needs an account and `LOCALSTACK_AUTH_TOKEN`; the free (Hobby) plan is for personal, non-commercial use; persistence (`PERSISTENCE=1`) is in the Base and Ultimate plans only ([docs](https://docs.localstack.cloud/aws/capabilities/state-management/persistence/)).

**MinIO**: the community edition stopped publishing images in October 2025, and its repository is archived.

**SeaweedFS 4.48** (`chrislusf/seaweedfs`, 2026-09-28, Apache 2.0, `linux/arm64`), `weed server -s3 -dir=/data` on a named volume:
- the AWS SDK for JavaScript with its default request checksums creates a bucket, puts, gets and lists, path-style;
- `s7cmd` 1.8.5 pushes, re-pushes by ETag and pulls a tree including a 20 MB file, with `--{source,target}-endpoint-url` and `--{source,target}-force-path-style`;
- an unsigned `PUT /<bucket>` creates a bucket (`200`), and `409` when it exists;
- each bucket is a collection of seven volumes, and the volume count defaults to the disk's free space over a 30 GB volume (20 on the machine checked), so a third bucket's puts failed `InternalError` ("No writable volumes and no free volumes left"). `-master.volumeSizeLimitMB=1024 -volume.max=1000` leaves room; volumes are not preallocated;
- data survives `docker compose down` and `up`. Until its volume server registers with the master, a stored object reads as `InternalError`, so the healthcheck also waits for a data node in `/dir/status`.

**DynamoDB Local 3.1.0** with `-sharedDb -dbPath` on a named volume keeps its tables across `down` and `up`; it runs as `root` there, since a named volume is created owned by root.
