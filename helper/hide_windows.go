//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideWindow скрывает консольное окно xray на Windows.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
