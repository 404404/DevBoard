// Compatibility entry point for the executable path used by the v0.1.0 updater.
// The renamed main executable owns initialization, migration, and instance locks.
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  (void)argc;
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) == 0) {
    char *name = strrchr(executable, '/');
    if (name != NULL) {
      size_t available = sizeof(executable) - (size_t)(name + 1 - executable);
      int written = snprintf(name + 1, available, "%s", "codexboard-desktop");
      if (written > 0 && (size_t)written < available) {
        argv[0] = executable;
        execv(executable, argv);
      }
    }
  }
  fputs("无法启动更新后的 DevBoard，请重新安装完整应用。\n", stderr);
  return 1;
}
