//go:build !windows

package whisper

import (
	"os/exec"
	"syscall"
)

func lowerPriority(*exec.Cmd) {}

// afterStart drops Whisper to a low scheduling priority so that the class being
// recorded, and the recording itself, always win the CPU.
func afterStart(cmd *exec.Cmd) {
	_ = syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10)
}
