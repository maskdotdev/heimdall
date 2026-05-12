package process

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type PythonRunner struct {
	WorkDir string
	Env     []string
}

func (runner PythonRunner) RunModule(ctx context.Context, module string, input any, output any) error {
	payload, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("encode %s input: %w", module, err)
	}

	command := exec.CommandContext(ctx, "python3", "-m", module)
	command.Dir = runner.WorkDir
	command.Stdin = bytes.NewReader(payload)
	command.Env = append(os.Environ(), runner.Env...)

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr

	if err := command.Run(); err != nil {
		return fmt.Errorf("run %s: %w: %s", module, err, strings.TrimSpace(stderr.String()))
	}
	if err := json.Unmarshal(stdout.Bytes(), output); err != nil {
		return fmt.Errorf("decode %s output: %w: %s", module, err, stdout.String())
	}
	return nil
}
