"use strict";

// Windows Job Object — the child-process safety net `taskkill /T` can never
// be. taskkill only runs on exit paths the main process controls; when main
// dies abruptly (crash, kill, power loss), nothing runs. A job object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flips the guarantee into the KERNEL:
// the OS closes the job handle when our process dies, and every assigned
// child (python backend, uv, MCP servers, PTY shells) is terminated with it.
//
// Belt-and-suspenders posture: every failure mode degrades to the previous
// behavior (taskkill sweep). koffi (declarative FFI over kernel32, NAPI
// prebuilt — no native compile) is loaded lazily; if it is missing, or any
// Win32 call fails, `assignChildToJob` simply returns false and the caller
// moves on. Non-Windows platforms are a permanent no-op.

const win32 = process.platform === "win32";

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

/** @type {null | { assign: (pid: number) => boolean }} */
let job = null;
let initialized = false;

function init() {
  if (!win32 || initialized) return null;
  initialized = true;
  try {
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");

    const ioCounters = koffi.struct("TDEASE_IO_COUNTERS", {
      ReadOperationCount: "uint64_t",
      WriteOperationCount: "uint64_t",
      OtherOperationCount: "uint64_t",
      ReadTransferCount: "uint64_t",
      WriteTransferCount: "uint64_t",
      OtherTransferCount: "uint64_t",
    });
    const basicLimits = koffi.struct("TDEASE_JOBOBJECT_BASIC_LIMIT_INFORMATION", {
      PerProcessUserTimeLimit: "int64_t",
      PerJobUserTimeLimit: "int64_t",
      LimitFlags: "uint32_t",
      MinimumWorkingSet: "uintptr_t",
      MaximumWorkingSet: "uintptr_t",
      ActiveProcessLimit: "uint32_t",
      Affinity: "uintptr_t",
      PriorityClass: "uint32_t",
      SchedulingClass: "int32_t",
    });
    const extendedLimits = koffi.struct("TDEASE_JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
      BasicLimitInformation: basicLimits,
      IoInfo: ioCounters,
      ProcessMemoryLimit: "uintptr_t",
      JobMemoryLimit: "uintptr_t",
      PeakProcessMemoryUsed: "uintptr_t",
      PeakJobMemoryUsed: "uintptr_t",
    });

    const CreateJobObjectW = kernel32.func("CreateJobObjectW", "void *", ["void *", "void *"]);
    // The limits block is passed as a POINTER TO the struct — a plain 'void *'
    // parameter would refuse the JS object koffi marshals for struct pointers.
    const SetInformationJobObject = kernel32.func(
      "SetInformationJobObject", "int", ["void *", "int", koffi.pointer(extendedLimits), "unsigned long"],
    );
    const OpenProcess = kernel32.func(
      "OpenProcess", "void *", ["unsigned long", "int", "unsigned long"],
    );
    const AssignProcessToJobObject = kernel32.func(
      "AssignProcessToJobObject", "int", ["void *", "void *"],
    );
    const CloseHandle = kernel32.func("CloseHandle", "int", ["void *"]);

    const handle = CreateJobObjectW(null, null);
    if (!handle) return null;
    // A plain object marshals into the pointed-to struct (zero-initialized
    // beyond the fields given — exactly the Win32 contract for "no limit").
    const info = {
      BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE },
    };
    if (SetInformationJobObject(handle, JobObjectExtendedLimitInformation, info, koffi.sizeof(extendedLimits)) === 0) {
      CloseHandle(handle);
      return null;
    }
    job = {
      assign(pid) {
        try {
          const process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
          if (!process) return false;
          const assigned = AssignProcessToJobObject(handle, process) !== 0;
          CloseHandle(process);
          return assigned;
        } catch {
          return false;
        }
      },
    };
    return job;
  } catch {
    return null;
  }
}

/**
 * Assign one child process (or PTY) to the kill-on-close job. Returns true
 * when the kernel accepted the assignment — callers treat false as "the
 * taskkill fallback still owns this child", never as an error.
 */
function assignChildToJob(child) {
  const pid = typeof child === "number" ? child : child?.pid;
  if (!win32 || typeof pid !== "number" || pid <= 0) return false;
  const handle = job ?? init();
  if (!handle) return false;
  return handle.assign(pid);
}

module.exports = { assignChildToJob };
