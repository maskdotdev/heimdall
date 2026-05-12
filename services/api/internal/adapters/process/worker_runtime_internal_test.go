package process

import (
	"strings"
	"testing"
)

func TestWorkerRuntimeBuildsPythonPath(t *testing.T) {
	runtime := WorkerRuntime{RepoRoot: "/repo"}
	pythonPath := runtime.pythonPath()

	for _, path := range []string{
		"/repo/contracts/generated/python",
		"/repo/workers/code-intel/src",
		"/repo/workers/review/src",
	} {
		if !strings.Contains(pythonPath, path) {
			t.Fatalf("python path missing %s: %s", path, pythonPath)
		}
	}
}
