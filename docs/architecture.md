# Architecture

The production system is a single Python 3 application: NiceGUI provides the browser presentation layer on top of FastAPI/Starlette, while all persistence, extraction, classification, rule evaluation, and report creation run server-side. MySQL is the system of record; evidence binaries live in the mounted data volume and only their metadata/path/checksum are stored in MySQL.

The API is mounted at `/api/v1`; generated OpenAPI documentation is at `/api/docs`. Session cookies contain an opaque random token. Only its SHA-256 digest is persisted in `user_sessions`, enabling expiry and revocation without exposing credential material.

Rule source is retained in `rule checklist/` and migrated to the version-controlled `app/db/seed_data/` JSON files. Database seeding creates a checksum-addressed checklist version, so each audit session pins the version used.
