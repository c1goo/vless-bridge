//go:build !windows

package main

import "os/exec"

// На macOS/Linux скрывать нечего.
func hideWindow(cmd *exec.Cmd) {}
