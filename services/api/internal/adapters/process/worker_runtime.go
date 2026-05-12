package process

import (
	"context"
	"strings"
)

type WorkerRuntime struct {
	RepoRoot string
	Env      []string
}

func (runtime WorkerRuntime) RunModule(ctx context.Context, module string, input any, output any) error {
	runner := PythonRunner{
		WorkDir: runtime.RepoRoot,
		Env:     append([]string{runtime.pythonPath()}, runtime.Env...),
	}
	return runner.RunModule(ctx, module, input, output)
}

func (runtime WorkerRuntime) pythonPath() string {
	return "PYTHONPATH=" + strings.Join([]string{
		runtime.RepoRoot + "/contracts/generated/python",
		runtime.RepoRoot + "/workers/code-intel/src",
		runtime.RepoRoot + "/workers/review/src",
	}, ":")
}
