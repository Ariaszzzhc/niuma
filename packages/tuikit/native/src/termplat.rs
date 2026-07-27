//! Terminal platform setup — Windows console code page + VT processing.
//!
//! On Windows, a console whose code page is a legacy ANSI/OEM page (e.g.
//! 936/GBK) decodes the crate's UTF-8 output as garbage, and consoles that
//! predate explicit VT enabling ignore SGR sequences entirely. `setup`
//! switches input/output code pages to UTF-8 (65001) and ORs
//! `ENABLE_VIRTUAL_TERMINAL_PROCESSING` into the stdout console mode,
//! remembering the previous values; `teardown` restores them. Both are
//! idempotent and safe to call in any order.
//!
//! On non-Windows targets both functions are no-ops returning 0 — the TS
//! layer also guards on `Deno.build.os`, but the symbols must exist in the
//! cdylib on every platform so `Deno.dlopen` never fails to resolve them.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    use windows_sys::Win32::Foundation::{GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{
        GetConsoleCP, GetConsoleMode, GetConsoleOutputCP, GetStdHandle, SetConsoleCP,
        SetConsoleMode, SetConsoleOutputCP, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    const CP_UTF8: u32 = 65001;
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x4;

    /// True between a successful state save (setup) and its restore
    /// (teardown). Guards against double-setup and teardown-without-setup.
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static SAVED_OUT_CP: AtomicU32 = AtomicU32::new(0);
    static SAVED_IN_CP: AtomicU32 = AtomicU32::new(0);
    static SAVED_OUT_MODE: AtomicU32 = AtomicU32::new(0);
    static SAVED_IN_MODE: AtomicU32 = AtomicU32::new(0);
    /// Console modes can only be read from real console handles — a
    /// redirected stdout/stdin (pipe, file) has none. These record whether
    /// the corresponding saved mode is meaningful and must be restored.
    static HAVE_OUT_MODE: AtomicBool = AtomicBool::new(false);
    static HAVE_IN_MODE: AtomicBool = AtomicBool::new(false);

    /// Read the console mode of `std_handle` (STD_OUTPUT/STD_INPUT_HANDLE).
    /// Returns the mode, or None when the handle is not a console.
    unsafe fn read_mode(std_handle: u32) -> Option<u32> {
        unsafe {
            let h = GetStdHandle(std_handle);
            if h.is_null() || h == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut mode: u32 = 0;
            if GetConsoleMode(h, &mut mode) == 0 {
                return None;
            }
            Some(mode)
        }
    }

    /// Apply `mode` to the console behind `std_handle`. Returns the Win32
    /// error code on failure, 0 on success or when there is no console.
    unsafe fn write_mode(std_handle: u32, mode: u32) -> u32 {
        unsafe {
            let h = GetStdHandle(std_handle);
            if h.is_null() || h == INVALID_HANDLE_VALUE {
                return 0;
            }
            if SetConsoleMode(h, mode) == 0 {
                return GetLastError();
            }
            0
        }
    }

    pub fn setup() -> i64 {
        // Already set up: a second call must not overwrite the saved state.
        if ACTIVE.swap(true, Ordering::SeqCst) {
            return 0;
        }
        let mut err: u32 = 0;
        unsafe {
            SAVED_OUT_CP.store(GetConsoleOutputCP(), Ordering::SeqCst);
            SAVED_IN_CP.store(GetConsoleCP(), Ordering::SeqCst);

            if SetConsoleOutputCP(CP_UTF8) == 0 {
                err = GetLastError();
            }
            if err == 0 && SetConsoleCP(CP_UTF8) == 0 {
                err = GetLastError();
            }

            // stdout: keep every existing flag (incl. ENABLE_PROCESSED_OUTPUT)
            // and add VT processing.
            match read_mode(STD_OUTPUT_HANDLE) {
                Some(mode) => {
                    SAVED_OUT_MODE.store(mode, Ordering::SeqCst);
                    HAVE_OUT_MODE.store(true, Ordering::SeqCst);
                    let e =
                        write_mode(STD_OUTPUT_HANDLE, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
                    if err == 0 {
                        err = e;
                    }
                }
                None => HAVE_OUT_MODE.store(false, Ordering::SeqCst),
            }
            // stdin: snapshot only — raw mode is Deno's business. TS calls
            // teardown after setRaw(false), so restoring the original mode
            // here is a no-op safety net, not a change.
            match read_mode(STD_INPUT_HANDLE) {
                Some(mode) => {
                    SAVED_IN_MODE.store(mode, Ordering::SeqCst);
                    HAVE_IN_MODE.store(true, Ordering::SeqCst);
                }
                None => HAVE_IN_MODE.store(false, Ordering::SeqCst),
            }
        }
        // Even on partial failure we stay ACTIVE: teardown restores whatever
        // was successfully saved. The caller treats nonzero as advisory.
        err as i64
    }

    pub fn teardown() -> i64 {
        // Never set up (or already torn down): nothing to restore.
        if !ACTIVE.swap(false, Ordering::SeqCst) {
            return 0;
        }
        let mut err: u32 = 0;
        unsafe {
            if SetConsoleOutputCP(SAVED_OUT_CP.load(Ordering::SeqCst)) == 0 {
                err = GetLastError();
            }
            if err == 0 && SetConsoleCP(SAVED_IN_CP.load(Ordering::SeqCst)) == 0 {
                err = GetLastError();
            }
            if HAVE_OUT_MODE.swap(false, Ordering::SeqCst) {
                let e = write_mode(STD_OUTPUT_HANDLE, SAVED_OUT_MODE.load(Ordering::SeqCst));
                if err == 0 {
                    err = e;
                }
            }
            if HAVE_IN_MODE.swap(false, Ordering::SeqCst) {
                let e = write_mode(STD_INPUT_HANDLE, SAVED_IN_MODE.load(Ordering::SeqCst));
                if err == 0 {
                    err = e;
                }
            }
        }
        err as i64
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn setup() -> i64 {
        0
    }

    pub fn teardown() -> i64 {
        0
    }
}

pub fn terminal_setup_impl() -> i64 {
    imp::setup()
}

pub fn terminal_teardown_impl() -> i64 {
    imp::teardown()
}
