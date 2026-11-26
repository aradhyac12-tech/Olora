#!/usr/bin/env bash
# Fails if a node:test summary log shows zero tests, any failure/cancellation, or any SKIPPED test.
# A skipped test is "not run", and "not run" must never turn CI green.
# Usage: ci/assert-no-skips.sh <log-file> <min-expected-tests>
set -u
log="${1:?log file}"; min="${2:?min tests}"
num() { grep -E "^# $1 " "$log" | tail -1 | awk '{print $3}'; }
tests=$(num tests); pass=$(num pass); fail=$(num fail); skipped=$(num skipped); cancelled=$(num cancelled)
[ -n "$tests" ] || { echo "ASSERT FAILED: no node:test summary found in $log"; exit 1; }
[ "${tests}" -ge "$min" ]   || { echo "ASSERT FAILED: only $tests tests ran, expected >= $min"; exit 1; }
[ "${fail:-1}" = "0" ] && [ "${cancelled:-1}" = "0" ] || { echo "ASSERT FAILED: fail=$fail cancelled=$cancelled"; exit 1; }
[ "${skipped:-1}" = "0" ]   || { echo "ASSERT FAILED: $skipped test(s) SKIPPED (not run)"; exit 1; }
[ "$pass" = "$tests" ]      || { echo "ASSERT FAILED: pass=$pass tests=$tests"; exit 1; }
echo "OK: $tests tests, 0 failed, 0 skipped ($log)"
