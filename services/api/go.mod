module heimdall.dev/services/api

go 1.22

require (
	github.com/mattn/go-sqlite3 v1.14.32
	heimdall.dev/contracts/generated/go v0.0.0
)

replace heimdall.dev/contracts/generated/go => ../../contracts/generated/go
