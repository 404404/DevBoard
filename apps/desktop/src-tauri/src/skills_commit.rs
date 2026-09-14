use std::{
    ffi::{CString, OsStr},
    mem::MaybeUninit,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
};

const TARGET: &str = "manage-lark-taskboard";
const STAGING_PREFIX: &str = ".manage-lark-taskboard.install-";

fn open_directory(parent: RawFd, name: &OsStr) -> Result<OwnedFd, String> {
    let name = CString::new(name.as_bytes()).map_err(|_| "Skill 目录名称无效")?;
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("无法打开 Skill 目录，目录必须存在且不能是符号链接".into());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn destination(home: &Path, staging_name: &str) -> Result<(OwnedFd, CString, CString), String> {
    if !home.is_absolute()
        || !staging_name.starts_with(STAGING_PREFIX)
        || staging_name.len() == STAGING_PREFIX.len()
        || staging_name.contains(['/', '\\', '\0'])
    {
        return Err("Skill 安装路径或暂存目录名称无效".into());
    }
    let mut directory = open_directory(libc::AT_FDCWD, OsStr::new("/"))?;
    for component in home.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                directory = open_directory(directory.as_raw_fd(), name)?;
            }
            _ => return Err("Skill 用户目录必须是无上级跳转的绝对路径".into()),
        }
    }
    for name in [".agents", "skills"] {
        directory = open_directory(directory.as_raw_fd(), OsStr::new(name))?;
    }
    Ok((
        directory,
        CString::new(TARGET).unwrap(),
        CString::new(staging_name).map_err(|_| "Skill 暂存目录名称无效")?,
    ))
}

fn identity(parent: RawFd, name: &CString) -> Result<Option<(u64, u64)>, String> {
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent,
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err("无法检查 Skill 目录身份".into())
        };
    }
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err("Skill 目标和暂存位置必须是目录，不能是文件或符号链接".into());
    }
    Ok(Some((stat.st_dev as u64, stat.st_ino)))
}

fn rename(parent: RawFd, from: &CString, to: &CString, flags: libc::c_uint) -> Result<(), String> {
    if unsafe { libc::renameatx_np(parent, from.as_ptr(), parent, to.as_ptr(), flags) } != 0 {
        return Err("Skill 原子目录提交失败，未完成目录交换".into());
    }
    Ok(())
}

// The caller serializes installs and validates directory contents immediately
// before this call. macOS renameatx_np has no inode compare-and-swap option.
pub fn atomic_install(
    home: &Path,
    staging_name: &str,
    expected_target: Option<(u64, u64)>,
) -> Result<(), String> {
    let (parent, target, staging) = destination(home, staging_name)?;
    let fd = parent.as_raw_fd();
    if identity(fd, &staging)?.is_none() {
        return Err("Skill 暂存目录不存在".into());
    }
    if identity(fd, &target)? != expected_target {
        return Err("Skill 目标目录已变化，未提交安装".into());
    }
    rename(
        fd,
        &staging,
        &target,
        if expected_target.is_some() {
            libc::RENAME_SWAP
        } else {
            libc::RENAME_EXCL
        },
    )
}

// Undo only a successful first install. Keep the directory under its original
// staging name for the caller to clean up; never overwrite another staging entry.
pub fn rollback_new_install(
    home: &Path,
    staging_name: &str,
    expected_target: (u64, u64),
) -> Result<(), String> {
    let (parent, target, staging) = destination(home, staging_name)?;
    let fd = parent.as_raw_fd();
    if identity(fd, &target)? != Some(expected_target) {
        return Err("Skill 目标目录已变化，未回退安装".into());
    }
    if identity(fd, &staging)?.is_some() {
        return Err("Skill 暂存位置已存在，未回退安装".into());
    }
    rename(fd, &target, &staging, libc::RENAME_EXCL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    const STAGE: &str = ".manage-lark-taskboard.install-test";

    struct Fixture {
        root: PathBuf,
        home: PathBuf,
        skills: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "lark-skills-commit-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let home = root.join("home");
            let skills = home.join(".agents/skills");
            fs::create_dir_all(&skills).unwrap();
            Self { root, home, skills }
        }

        fn directory(&self, name: &str, text: &str) -> PathBuf {
            let path = self.skills.join(name);
            fs::create_dir(&path).unwrap();
            fs::write(path.join("SKILL.md"), text).unwrap();
            path
        }

        fn text(&self, name: &str) -> String {
            fs::read_to_string(self.skills.join(name).join("SKILL.md")).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn id(path: &Path) -> (u64, u64) {
        let meta = fs::symlink_metadata(path).unwrap();
        (meta.dev(), meta.ino())
    }

    #[test]
    fn first_install_moves_staging_without_overwriting_an_existing_target() {
        let fixture = Fixture::new();
        let staging = fixture.directory(STAGE, "new");
        let staged_id = id(&staging);
        atomic_install(&fixture.home, STAGE, None).unwrap();
        assert_eq!(fixture.text(TARGET), "new");
        assert_eq!(id(&fixture.skills.join(TARGET)), staged_id);
        assert!(!staging.exists());
        fixture.directory(STAGE, "another");
        assert!(atomic_install(&fixture.home, STAGE, None).is_err());
        assert_eq!(fixture.text(TARGET), "new");
        assert_eq!(fixture.text(STAGE), "another");
    }

    #[test]
    fn replacement_swaps_whole_directories_and_preserves_old_contents_in_staging() {
        let fixture = Fixture::new();
        let old_id = id(&fixture.directory(TARGET, "old"));
        let new_id = id(&fixture.directory(STAGE, "new"));
        atomic_install(&fixture.home, STAGE, Some(old_id)).unwrap();
        assert_eq!(fixture.text(TARGET), "new");
        assert_eq!(fixture.text(STAGE), "old");
        assert_eq!(id(&fixture.skills.join(TARGET)), new_id);
        assert_eq!(id(&fixture.skills.join(STAGE)), old_id);
        atomic_install(&fixture.home, STAGE, Some(new_id)).unwrap();
        assert_eq!(fixture.text(TARGET), "old");
        assert_eq!(fixture.text(STAGE), "new");
    }

    #[test]
    fn changed_target_identity_leaves_both_directories_untouched() {
        let fixture = Fixture::new();
        let original = fixture.directory(TARGET, "old");
        let (device, inode) = id(&original);
        fixture.directory(STAGE, "new");
        for expected in [
            (device.wrapping_add(1), inode),
            (device, inode.wrapping_add(1)),
        ] {
            assert!(atomic_install(&fixture.home, STAGE, Some(expected)).is_err());
            assert_eq!(fixture.text(TARGET), "old");
            assert_eq!(fixture.text(STAGE), "new");
        }
    }

    #[test]
    fn target_and_staging_symlinks_are_rejected() {
        let fixture = Fixture::new();
        let outside = fixture.root.join("outside");
        fs::create_dir(&outside).unwrap();
        fixture.directory(STAGE, "new");
        symlink(&outside, fixture.skills.join(TARGET)).unwrap();
        assert!(atomic_install(&fixture.home, STAGE, None).is_err());
        fs::remove_file(fixture.skills.join(TARGET)).unwrap();
        fs::remove_dir_all(fixture.skills.join(STAGE)).unwrap();
        symlink(&outside, fixture.skills.join(STAGE)).unwrap();
        assert!(atomic_install(&fixture.home, STAGE, None).is_err());
        assert!(fs::read_dir(outside).unwrap().next().is_none());
    }

    #[test]
    fn home_and_parent_directory_symlinks_are_rejected() {
        let fixture = Fixture::new();
        fixture.directory(STAGE, "new");
        let home_link = fixture.root.join("home-link");
        symlink(&fixture.home, &home_link).unwrap();
        assert!(atomic_install(&home_link, STAGE, None).is_err());
        let actual = fixture.home.join("actual-agents");
        fs::rename(fixture.home.join(".agents"), &actual).unwrap();
        symlink(&actual, fixture.home.join(".agents")).unwrap();
        assert!(atomic_install(&fixture.home, STAGE, None).is_err());
        assert_eq!(fixture.text(STAGE), "new");
        assert!(!fixture.skills.join(TARGET).exists());
    }

    #[test]
    fn invalid_staging_names_and_missing_staging_are_rejected() {
        let fixture = Fixture::new();
        fixture.directory(STAGE, "new");
        for name in [
            "",
            TARGET,
            STAGING_PREFIX,
            "../escape",
            ".manage-lark-taskboard.install-a/b",
            ".manage-lark-taskboard.install-a\\b",
            ".manage-lark-taskboard.install-a\0b",
        ] {
            assert!(atomic_install(&fixture.home, name, None).is_err());
        }
        assert!(atomic_install(
            &fixture.home,
            ".manage-lark-taskboard.install-missing",
            None
        )
        .is_err());
        assert_eq!(fixture.text(STAGE), "new");
        assert!(!fixture.skills.join(TARGET).exists());
    }

    #[test]
    fn first_install_rollback_moves_only_the_expected_directory_back_to_staging() {
        let fixture = Fixture::new();
        let expected = id(&fixture.directory(STAGE, "new"));
        atomic_install(&fixture.home, STAGE, None).unwrap();
        rollback_new_install(&fixture.home, STAGE, expected).unwrap();
        assert!(!fixture.skills.join(TARGET).exists());
        assert_eq!(fixture.text(STAGE), "new");
        assert_eq!(id(&fixture.skills.join(STAGE)), expected);
    }

    #[test]
    fn rollback_rejects_changed_identity_or_occupied_staging_without_overwriting() {
        let fixture = Fixture::new();
        let expected = id(&fixture.directory(TARGET, "new"));
        assert!(rollback_new_install(
            &fixture.home,
            STAGE,
            (expected.0, expected.1.wrapping_add(1))
        )
        .is_err());
        fixture.directory(STAGE, "unrelated");
        assert!(rollback_new_install(&fixture.home, STAGE, expected).is_err());
        assert_eq!(fixture.text(TARGET), "new");
        assert_eq!(fixture.text(STAGE), "unrelated");
    }
}
