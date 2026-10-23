//go:build windows

package whisper

import (
	"os/exec"
	"syscall"
)

const belowNormalPriorityClass = 0x00004000

// lowerPriority starts Whisper below normal priority so that the class being
// recorded, and the recording itself, always win the CPU.
func lowerPriority(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: belowNormalPriorityClass}
}

func afterStart(*exec.Cmd) {}
