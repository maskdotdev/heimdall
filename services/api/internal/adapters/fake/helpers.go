package fake

import contracts "heimdall.dev/contracts/generated/go"

func stringPointer(value string) *string {
	return &value
}

func uriPointer(value string) *contracts.Uri {
	uri := contracts.Uri(value)
	return &uri
}

func intPointer(value int) *int {
	return &value
}
