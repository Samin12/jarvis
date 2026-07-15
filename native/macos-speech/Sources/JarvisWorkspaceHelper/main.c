#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_CONTENT_BYTES (192u * 1024u)
#define MAX_COMPONENTS 128u

static void fail(const char *message) {
  fprintf(stderr, "jarvis-workspace-helper: %s\n", message);
  exit(1);
}

static void fail_errno(const char *message) {
  fprintf(stderr, "jarvis-workspace-helper: %s: %s\n", message, strerror(errno));
  exit(1);
}

static uint64_t parse_u64(const char *value, const char *label) {
  if (value == NULL || value[0] == '\0' || value[0] == '-') fail(label);
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != '\0'; cursor++) {
    if (*cursor < '0' || *cursor > '9') fail(label);
  }
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') fail(label);
  return (uint64_t)parsed;
}

static void read_exact_stdin(unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(STDIN_FILENO, buffer + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      fail_errno("could not read approved content");
    }
    if (count == 0) fail("approved content ended early");
    offset += (size_t)count;
  }
  unsigned char extra = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, &extra, 1);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) fail_errno("could not finish reading approved content");
    if (count != 0) fail("approved content contained trailing bytes");
    return;
  }
}

static void pread_exact(int fd, unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = pread(fd, buffer + offset, length - offset, (off_t)offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      fail_errno("could not read the exact workspace file");
    }
    if (count == 0) fail("workspace file ended early");
    offset += (size_t)count;
  }
}

static void pwrite_exact(int fd, const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = pwrite(fd, buffer + offset, length - offset, (off_t)offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      fail_errno("could not write the approved workspace content");
    }
    if (count == 0) fail("workspace write made no progress");
    offset += (size_t)count;
  }
}

static void require_directory_identity(int fd, uint64_t expected_dev, uint64_t expected_ino,
                                       const char *label) {
  struct stat info;
  if (fstat(fd, &info) != 0) fail_errno(label);
  if (!S_ISDIR(info.st_mode) || (uint64_t)info.st_dev != expected_dev ||
      (uint64_t)info.st_ino != expected_ino) {
    fail(label);
  }
}

static int open_bound_parent(const char *root_path, const char *relative_path,
                             uint64_t root_dev, uint64_t root_ino, uint64_t parent_dev,
                             uint64_t parent_ino, char **target_name_out) {
  size_t path_length = strlen(relative_path);
  if (path_length == 0 || path_length > PATH_MAX || relative_path[0] == '/' ||
      relative_path[path_length - 1] == '/' || strstr(relative_path, "//") != NULL) {
    fail("workspace-relative path is invalid");
  }

  char *path = strdup(relative_path);
  if (path == NULL) fail_errno("could not allocate path state");
  char *last_slash = strrchr(path, '/');
  char *target_name = last_slash == NULL ? path : last_slash + 1;
  if (target_name[0] == '\0' || strcmp(target_name, ".") == 0 ||
      strcmp(target_name, "..") == 0 || strlen(target_name) > NAME_MAX) {
    fail("workspace target name is invalid");
  }
  if (last_slash != NULL) *last_slash = '\0';

  int current = open(root_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) fail_errno("could not open the approved workspace root");
  require_directory_identity(current, root_dev, root_ino,
                             "approved workspace root identity changed");

  if (last_slash != NULL && path[0] != '\0') {
    char *save = NULL;
    char *component = strtok_r(path, "/", &save);
    /* The target name counts toward the same total path-component ceiling. */
    size_t component_count = 1;
    while (component != NULL) {
      component_count += 1;
      if (component_count > MAX_COMPONENTS || component[0] == '\0' ||
          strcmp(component, ".") == 0 || strcmp(component, "..") == 0 ||
          strlen(component) > NAME_MAX) {
        fail("workspace parent path is invalid");
      }
      int next = openat(current, component,
                        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) fail_errno("workspace parent is no longer a physical directory");
      close(current);
      current = next;
      component = strtok_r(NULL, "/", &save);
    }
  }

  require_directory_identity(current, parent_dev, parent_ino,
                             "approved workspace parent identity changed");
  *target_name_out = strdup(target_name);
  free(path);
  if (*target_name_out == NULL) fail_errno("could not allocate target state");
  return current;
}

static void verify_regular_identity(int fd, uint64_t expected_dev, uint64_t expected_ino,
                                    size_t expected_size, mode_t expected_mode) {
  struct stat info;
  if (fstat(fd, &info) != 0) fail_errno("could not inspect the approved workspace file");
  if (!S_ISREG(info.st_mode) || info.st_nlink != 1 || (uint64_t)info.st_dev != expected_dev ||
      (uint64_t)info.st_ino != expected_ino || (uint64_t)info.st_size != expected_size ||
      (info.st_mode & 0777) != expected_mode) {
    fail("approved workspace file identity changed");
  }
}

static void verify_target_path_identity(int parent_fd, const char *target_name,
                                        uint64_t expected_dev, uint64_t expected_ino,
                                        size_t expected_size, mode_t expected_mode) {
  struct stat info;
  if (fstatat(parent_fd, target_name, &info, AT_SYMLINK_NOFOLLOW) != 0) {
    fail_errno("could not rebind the written workspace path");
  }
  if (!S_ISREG(info.st_mode) || info.st_nlink != 1 ||
      (uint64_t)info.st_dev != expected_dev || (uint64_t)info.st_ino != expected_ino ||
      (uint64_t)info.st_size != expected_size || (info.st_mode & 0777) != expected_mode) {
    fail("written workspace path was redirected");
  }
}

int main(int argc, char **argv) {
  if (argc != 14 || strcmp(argv[1], "write") != 0) {
    fail("expected write protocol arguments");
  }

  const char *root_path = argv[2];
  const char *relative_path = argv[3];
  uint64_t root_dev = parse_u64(argv[4], "workspace root device is invalid");
  uint64_t root_ino = parse_u64(argv[5], "workspace root inode is invalid");
  uint64_t parent_dev = parse_u64(argv[6], "workspace parent device is invalid");
  uint64_t parent_ino = parse_u64(argv[7], "workspace parent inode is invalid");
  int updating = strcmp(argv[8], "update") == 0;
  if (!updating && strcmp(argv[8], "add") != 0) fail("workspace write kind is invalid");
  uint64_t target_dev = parse_u64(argv[9], "workspace target device is invalid");
  uint64_t target_ino = parse_u64(argv[10], "workspace target inode is invalid");
  uint64_t old_length_u64 = parse_u64(argv[11], "old content length is invalid");
  uint64_t new_length_u64 = parse_u64(argv[12], "new content length is invalid");
  uint64_t mode_u64 = parse_u64(argv[13], "workspace mode is invalid");
  if (old_length_u64 > MAX_CONTENT_BYTES || new_length_u64 > MAX_CONTENT_BYTES ||
      mode_u64 > 0777 ||
      (!updating &&
       (old_length_u64 != 0 || target_dev != 0 || target_ino != 0))) {
    fail("workspace write exceeds its bounded protocol");
  }
  size_t old_length = (size_t)old_length_u64;
  size_t new_length = (size_t)new_length_u64;
  mode_t mode = (mode_t)mode_u64;
  size_t input_length = old_length + new_length;
  unsigned char *input = malloc(input_length == 0 ? 1 : input_length);
  if (input == NULL) fail_errno("could not allocate bounded content state");
  read_exact_stdin(input, input_length);
  const unsigned char *old_content = input;
  const unsigned char *new_content = input + old_length;

  char *target_name = NULL;
  int parent_fd = open_bound_parent(root_path, relative_path, root_dev, root_ino, parent_dev,
                                    parent_ino, &target_name);
  int file_fd = -1;
  uint64_t written_dev = 0;
  uint64_t written_ino = 0;
  if (updating) {
    file_fd = openat(parent_fd, target_name, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (file_fd < 0) fail_errno("could not open the exact approved workspace file");
    if (flock(file_fd, LOCK_EX | LOCK_NB) != 0) {
      fail_errno("approved workspace file is busy");
    }
    verify_regular_identity(file_fd, target_dev, target_ino, old_length, mode);
    unsigned char *observed = malloc(old_length == 0 ? 1 : old_length);
    if (observed == NULL) fail_errno("could not allocate verification state");
    pread_exact(file_fd, observed, old_length);
    if (memcmp(observed, old_content, old_length) != 0) fail("approved file content changed");
    free(observed);
    verify_regular_identity(file_fd, target_dev, target_ino, old_length, mode);
    written_dev = target_dev;
    written_ino = target_ino;
  } else {
    file_fd = openat(parent_fd, target_name,
                     O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode);
    if (file_fd < 0) fail_errno("could not create the exact approved workspace file");
    struct stat created;
    if (fstat(file_fd, &created) != 0 || !S_ISREG(created.st_mode) || created.st_nlink != 1) {
      fail("created workspace file identity is invalid");
    }
    written_dev = (uint64_t)created.st_dev;
    written_ino = (uint64_t)created.st_ino;
  }

  if (ftruncate(file_fd, (off_t)new_length) != 0) {
    fail_errno("could not size the approved workspace file");
  }
  pwrite_exact(file_fd, new_content, new_length);
  if (fchmod(file_fd, mode) != 0) fail_errno("could not preserve workspace file permissions");
  if (fsync(file_fd) != 0) fail_errno("could not flush the approved workspace file");

  struct stat after;
  if (fstat(file_fd, &after) != 0 || !S_ISREG(after.st_mode) || after.st_nlink != 1 ||
      (uint64_t)after.st_dev != written_dev || (uint64_t)after.st_ino != written_ino ||
      (uint64_t)after.st_size != new_length || (after.st_mode & 0777) != mode) {
    fail("workspace postcondition metadata is invalid");
  }
  unsigned char *verified = malloc(new_length == 0 ? 1 : new_length);
  if (verified == NULL) fail_errno("could not allocate postcondition state");
  pread_exact(file_fd, verified, new_length);
  if (memcmp(verified, new_content, new_length) != 0) {
    fail("workspace postcondition content is invalid");
  }
  free(verified);
  if (fsync(parent_fd) != 0 && errno != EINVAL) {
    fail_errno("could not flush the workspace parent directory");
  }

  /*
   * Re-open the approved root and every parent component after the mutation.
   * A write to a still-open inode is not a successful pathname mutation if a
   * concurrent process renamed the parent or replaced the target name.
   */
  char *rebound_target_name = NULL;
  int rebound_parent_fd = open_bound_parent(root_path, relative_path, root_dev, root_ino,
                                            parent_dev, parent_ino,
                                            &rebound_target_name);
  if (strcmp(rebound_target_name, target_name) != 0) {
    fail("written workspace target name changed");
  }
  verify_target_path_identity(rebound_parent_fd, rebound_target_name, written_dev,
                              written_ino, new_length, mode);

  printf("{\"ok\":true,\"bytes\":%llu}\n", (unsigned long long)new_length);
  free(rebound_target_name);
  free(target_name);
  free(input);
  close(rebound_parent_fd);
  close(file_fd);
  close(parent_fd);
  return 0;
}
