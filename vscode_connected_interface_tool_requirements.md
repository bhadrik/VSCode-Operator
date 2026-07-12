# Connected VS Code Interface — Complete Tool Requirements

**Document status:** Requirements baseline  
**Purpose:** Define the complete tool surface required for a connected VS Code interface that can safely inspect, modify, build, test, debug, validate, and manage a software project end to end.  
**Primary project context:** MotorMark Android application  
**Priority levels:**  
- **P0:** Required for normal development  
- **P1:** Required for a strong IDE-integrated engineering agent  
- **P2:** Advanced or future capability  

---

## 1. Quick Take

The current connected VS Code interface is inspection-focused. It can read files, search source, inspect diagnostics, query basic language information, and inspect a paused debugger.

It cannot yet complete the full engineering loop:

```text
Inspect → edit → format → build → test → debug → validate → review diff → commit
```

The four most important missing capability groups are:

1. Atomic file editing
2. Controlled terminal and task execution
3. Test/build result access
4. Git and physical Android device operations

---

## 2. Current Interface Capabilities

### 2.1 Workspace and file inspection

- `vscode_workspace_status`
- `vscode_workspace_list_roots`
- `vscode_workspace_list_files`
- `vscode_workspace_read_file`
- `vscode_workspace_stat`
- `vscode_workspace_search_text`
- `vscode_workspace_get_symbols`
- `vscode_workspace_read_problems`

### 2.2 Editor inspection

- `vscode_editor_list_open_documents`
- `vscodeOperator_activeEditorSummary`
- `vscodeOperator_hoverAtPosition`
- `vscodeOperator_hoverTopVisible`
- `vscodeOperator_completionAt`

### 2.3 Diagnostics

- `vscodeOperator_readProblems`
- `get_diagnostics`
- `get_problems`

### 2.4 Hover compatibility aliases

- `get_hover_info`
- `hover`

### 2.5 Read-only debugger inspection

- `vscodeOperator_debugStatus`
- `vscodeOperator_debugGetThreads`
- `vscodeOperator_debugGetTopFrame`
- `vscodeOperator_debugGetStackTrace`
- `vscodeOperator_debugGetScopes`
- `vscodeOperator_debugGetVariables`
- `vscodeOperator_debugGetExceptionInfo`
- `vscodeOperator_debugSnapshot`

### 2.6 Current limitations

The interface cannot currently:

- Create, edit, rename, move, copy, or delete files
- Apply patches
- Save unsaved documents
- Run shell commands
- Run VS Code tasks
- Run Gradle
- Run tests
- Use ADB
- Install or launch an APK
- Read terminal output
- Control debugger execution
- Manage breakpoints
- Inspect Git state through a structured API
- Commit or switch branches
- Format or refactor code
- Apply code actions
- Watch files and diagnostics for changes

---

## 3. Connection, Capability, and Policy Tools

### P0

- `vscode_connection_status`
- `vscode_capabilities_get`
- `vscode_environment_get`
- `vscode_workspace_status`
- `vscode_policy_get`
- `vscode_policy_explain`
- `vscode_policy_validate_operation`

### P1

- `vscode_session_get`
- `vscode_session_ping`
- `vscode_audit_list`
- `vscode_audit_export`

### P2

- `vscode_capabilities_watch`

### Required response metadata

Every tool response should include:

- Workspace root
- Whether the operation was allowed
- Policy rule involved
- Operation ID
- Timestamp
- Structured error code
- Output truncation status
- Retryability status

---

## 4. Workspace and File Reading

### P0 tools

- `vscode_workspace_list_roots`
- `vscode_workspace_list_files`
- `vscode_workspace_find_files`
- `vscode_workspace_read_file`
- `vscode_workspace_read_file_range`
- `vscode_workspace_read_files_batch`
- `vscode_workspace_read_binary`
- `vscode_workspace_stat`
- `vscode_workspace_hash_file`
- `vscode_workspace_hash_tree`
- `vscode_workspace_get_encoding`
- `vscode_workspace_get_eol`
- `vscode_workspace_get_symlink_target`
- `vscode_workspace_compare_files`
- `vscode_workspace_read_directory_tree`

### Required behavior

- UTF-8 and binary/base64 support
- Line-range and byte-range reads
- Pagination
- File-size limits
- Hashes for concurrency protection
- Multi-root workspace support
- Remote workspace support
- Symlink identification
- Protected-file exclusion

---

## 5. File Creation and Editing

This is the highest-priority missing category.

### P0 tools

- `vscode_workspace_apply_patch`
- `vscode_workspace_apply_text_edits`
- `vscode_workspace_write_file`
- `vscode_workspace_create_file`
- `vscode_workspace_create_directory`
- `vscode_workspace_delete_file`
- `vscode_workspace_delete_directory`
- `vscode_workspace_move`
- `vscode_workspace_copy`
- `vscode_workspace_batch_edit`
- `vscode_workspace_preview_edit`
- `vscode_workspace_undo_last_edit`

### Required parameters

Each write operation should support:

```text
workspacePath
path
expectedSha256 or expectedVersion
createParents
overwrite
dryRun
operationReason
```

### Mandatory safety behavior

- Atomic application
- All-or-nothing multi-file edits
- Diff preview
- Undo token
- Preserve encoding
- Preserve line endings
- Preserve executable permissions
- Reject symlink traversal
- Reject writes outside the workspace
- Detect dirty editor buffers
- Never overwrite unsaved user content silently

---

## 6. Editor and Document Tools

### Reading editor state

- `vscode_editor_list_open_documents`
- `vscode_editor_get_active`
- `vscode_editor_get_document_text`
- `vscode_editor_get_dirty_documents`
- `vscode_editor_get_selection`
- `vscode_editor_get_selections`
- `vscode_editor_get_visible_ranges`
- `vscode_editor_get_cursor`
- `vscode_editor_get_view_state`

The document-text tool must return the in-memory unsaved buffer, not only the saved file.

### Controlling the editor

- `vscode_editor_open_document`
- `vscode_editor_close_document`
- `vscode_editor_save_document`
- `vscode_editor_save_all`
- `vscode_editor_revert_document`
- `vscode_editor_reveal_range`
- `vscode_editor_set_selection`
- `vscode_editor_insert_text`
- `vscode_editor_replace_selection`
- `vscode_editor_show_diff`
- `vscode_editor_open_preview`
- `vscode_editor_focus`
- `vscode_editor_split`
- `vscode_editor_format_document`
- `vscode_editor_format_selection`

---

## 7. Search Tools

- `vscode_workspace_search_text`
- `vscode_workspace_search_regex`
- `vscode_workspace_search_word`
- `vscode_workspace_search_files`
- `vscode_workspace_search_filename`
- `vscode_workspace_search_recent_changes`
- `vscode_workspace_search_todos`
- `vscode_workspace_search_dependency_usage`
- `vscode_workspace_search_configuration_keys`

### Search requirements

- Regular expressions
- Case sensitivity
- Whole-word matching
- Include and exclude globs
- Git-ignore awareness
- Result pagination
- Context lines
- Maximum result limits
- Unsaved editor-buffer search where practical

---

## 8. Language Server and Code Intelligence

### Navigation

- `vscode_language_hover`
- `vscode_language_completion`
- `vscode_language_signature_help`
- `vscode_language_definition`
- `vscode_language_type_definition`
- `vscode_language_declaration`
- `vscode_language_implementation`
- `vscode_language_references`
- `vscode_language_document_symbols`
- `vscode_language_workspace_symbols`
- `vscode_language_call_hierarchy`
- `vscode_language_type_hierarchy`
- `vscode_language_incoming_calls`
- `vscode_language_outgoing_calls`

### Refactoring

- `vscode_language_prepare_rename`
- `vscode_language_rename_symbol`
- `vscode_language_code_actions`
- `vscode_language_apply_code_action`
- `vscode_language_refactor_actions`
- `vscode_language_organize_imports`
- `vscode_language_fix_all`
- `vscode_language_format_document`
- `vscode_language_format_range`

### Additional intelligence

- `vscode_language_document_highlights`
- `vscode_language_semantic_tokens`
- `vscode_language_inlay_hints`
- `vscode_language_folding_ranges`
- `vscode_language_selection_ranges`
- `vscode_language_document_links`
- `vscode_language_code_lenses`
- `vscode_language_colors`
- `vscode_language_diagnostics_at_position`

Code actions and refactors should support preview before application.

---

## 9. Diagnostics and Problems

- `vscode_diagnostics_read`
- `vscode_diagnostics_read_file`
- `vscode_diagnostics_read_range`
- `vscode_diagnostics_read_related`
- `vscode_diagnostics_group_by_source`
- `vscode_diagnostics_wait_for_stable`
- `vscode_diagnostics_watch_start`
- `vscode_diagnostics_watch_read`
- `vscode_diagnostics_watch_stop`
- `vscode_diagnostics_clear_owned`

### Diagnostic fields

Each diagnostic should include:

- File
- Severity
- Message
- Source
- Diagnostic code
- Start line and column
- End line and column
- Related locations
- Available code actions
- Document version

---

## 10. Controlled Command Execution

The bridge should not expose an unrestricted shell without policy controls.

### Required tools

- `vscode_command_list`
- `vscode_command_describe`
- `vscode_command_execute`
- `vscode_command_validate`
- `vscode_command_cancel`
- `vscode_command_get_result`

### Required command fields

```text
executable
args[]
cwd
environmentAllowlist
timeout
stdinMode
outputLimit
networkPolicy
approvalClass
```

### Preferred execution model

Use structured executable and argument arrays:

```json
{
  "executable": "./gradlew",
  "args": ["testDebugUnitTest"],
  "cwd": "/workspace"
}
```

Avoid passing arbitrary shell strings by default.

---

## 11. Terminal Tools

### P0

- `vscode_terminal_create`
- `vscode_terminal_list`
- `vscode_terminal_execute`
- `vscode_terminal_read_output`
- `vscode_terminal_send_input`
- `vscode_terminal_get_status`
- `vscode_terminal_cancel_execution`
- `vscode_terminal_kill`
- `vscode_terminal_dispose`

### P1

- `vscode_terminal_get_shell_integration`
- `vscode_terminal_get_exit_code`
- `vscode_terminal_get_cwd`
- `vscode_terminal_get_process_id`
- `vscode_terminal_resize`
- `vscode_terminal_show`
- `vscode_terminal_hide`
- `vscode_terminal_clear`
- `vscode_terminal_list_recent_commands`

### Required behavior

- Stream stdout and stderr
- Optional ANSI preservation
- Return exit code
- Cancellation
- Timeout
- Output limits
- Continuation tokens
- Child-process cleanup
- Secret redaction
- Network-access policy reporting

---

## 12. VS Code Task Tools

- `vscode_tasks_list`
- `vscode_tasks_get`
- `vscode_tasks_detect`
- `vscode_tasks_run`
- `vscode_tasks_get_execution`
- `vscode_tasks_read_output`
- `vscode_tasks_cancel`
- `vscode_tasks_restart`
- `vscode_tasks_get_dependencies`
- `vscode_tasks_get_problem_matcher_results`
- `vscode_tasks_watch`

### Required task support

- Workspace tasks
- Build tasks
- Test tasks
- Background tasks
- Task dependencies
- Problem matchers
- Exit status
- Output streaming
- Cancellation

---

## 13. Testing Tools

### Test discovery

- `vscode_tests_list_controllers`
- `vscode_tests_discover`
- `vscode_tests_list`
- `vscode_tests_get`
- `vscode_tests_list_profiles`
- `vscode_tests_refresh`

### Test execution

- `vscode_tests_run`
- `vscode_tests_debug`
- `vscode_tests_run_file`
- `vscode_tests_run_suite`
- `vscode_tests_run_case`
- `vscode_tests_run_failed`
- `vscode_tests_cancel`
- `vscode_tests_watch`

### Test results

- `vscode_tests_get_run`
- `vscode_tests_get_results`
- `vscode_tests_get_failures`
- `vscode_tests_get_output`
- `vscode_tests_get_failure_diff`
- `vscode_tests_get_coverage`
- `vscode_tests_get_file_coverage`
- `vscode_tests_export_report`

---

## 14. Build and Quality-Gate Tools

- `vscode_build_detect_system`
- `vscode_build_list_targets`
- `vscode_build_run`
- `vscode_build_clean`
- `vscode_build_cancel`
- `vscode_build_get_result`
- `vscode_build_get_artifacts`
- `vscode_quality_list_gates`
- `vscode_quality_run_gate`
- `vscode_quality_run_all`
- `vscode_quality_get_report`
- `vscode_quality_compare_runs`

### MotorMark required project commands

```bash
python3 scripts/verify_client_input.py
python3 scripts/verify_project_docs.py
python3 scripts/check_project_gates.py
python3 scripts/verify_source_policies.py
python3 scripts/verify_android_manifest.py
python3 scripts/run_quality_gates.py --strict
```

### MotorMark required Gradle commands

```bash
./gradlew compileDebugKotlin
./gradlew testDebugUnitTest
./gradlew lintDebug
./gradlew assembleDebugAndroidTest
./gradlew assembleDebug
./gradlew assembleRelease
```

---

## 15. Git and Source-Control Tools

### Read-only Git tools

- `vscode_scm_list_repositories`
- `vscode_scm_status`
- `vscode_scm_current_branch`
- `vscode_scm_list_branches`
- `vscode_scm_log`
- `vscode_scm_show_commit`
- `vscode_scm_diff`
- `vscode_scm_diff_file`
- `vscode_scm_diff_staged`
- `vscode_scm_blame`
- `vscode_scm_list_remotes`
- `vscode_scm_ahead_behind`
- `vscode_scm_merge_status`
- `vscode_scm_conflicts`

### Mutating Git tools

- `vscode_scm_stage`
- `vscode_scm_unstage`
- `vscode_scm_stage_all`
- `vscode_scm_discard_file`
- `vscode_scm_restore_file`
- `vscode_scm_commit`
- `vscode_scm_amend`
- `vscode_scm_create_branch`
- `vscode_scm_checkout`
- `vscode_scm_merge`
- `vscode_scm_rebase`
- `vscode_scm_abort_operation`
- `vscode_scm_stash`
- `vscode_scm_stash_pop`
- `vscode_scm_tag`
- `vscode_scm_fetch`
- `vscode_scm_pull`
- `vscode_scm_push`

### Explicit approval required for

- Discarding changes
- Reset
- Clean
- Force checkout
- Force push
- Rebase
- Branch deletion
- Tag deletion
- History rewriting
- Remote operations

---

## 16. Debugger Control

### Session control

- `vscode_debug_list_configurations`
- `vscode_debug_start`
- `vscode_debug_attach`
- `vscode_debug_restart`
- `vscode_debug_stop`
- `vscode_debug_disconnect`
- `vscode_debug_status`

### Execution control

- `vscode_debug_continue`
- `vscode_debug_pause`
- `vscode_debug_step_over`
- `vscode_debug_step_into`
- `vscode_debug_step_out`
- `vscode_debug_step_back`
- `vscode_debug_restart_frame`
- `vscode_debug_run_to_cursor`

### Breakpoint tools

- `vscode_debug_list_breakpoints`
- `vscode_debug_add_breakpoint`
- `vscode_debug_add_conditional_breakpoint`
- `vscode_debug_add_function_breakpoint`
- `vscode_debug_add_data_breakpoint`
- `vscode_debug_add_logpoint`
- `vscode_debug_enable_breakpoint`
- `vscode_debug_disable_breakpoint`
- `vscode_debug_remove_breakpoint`
- `vscode_debug_remove_all_breakpoints`

### Runtime inspection and modification

- `vscode_debug_get_threads`
- `vscode_debug_get_stack_trace`
- `vscode_debug_get_scopes`
- `vscode_debug_get_variables`
- `vscode_debug_get_exception_info`
- `vscode_debug_evaluate`
- `vscode_debug_set_variable`
- `vscode_debug_set_expression`
- `vscode_debug_get_watch_expressions`
- `vscode_debug_add_watch_expression`
- `vscode_debug_remove_watch_expression`
- `vscode_debug_console_execute`
- `vscode_debug_read_console`

---

## 17. Process and Runtime Tools

- `vscode_process_list`
- `vscode_process_get`
- `vscode_process_read_output`
- `vscode_process_send_signal`
- `vscode_process_terminate`
- `vscode_process_tree`
- `vscode_process_wait`
- `vscode_port_list`
- `vscode_port_forward`
- `vscode_port_stop_forwarding`
- `vscode_runtime_environment`
- `vscode_runtime_check_executable`
- `vscode_runtime_get_version`

Process termination should be restricted to bridge-created processes unless the user explicitly approves otherwise.

---

## 18. Android and ADB Tools

These are essential for MotorMark because physical-device validation is required.

### Device discovery

- `android_adb_status`
- `android_adb_list_devices`
- `android_adb_get_device`
- `android_adb_wait_for_device`
- `android_adb_authorization_status`
- `android_device_is_unlocked`
- `android_device_get_api_level`
- `android_device_get_properties`
- `android_device_get_storage`
- `android_device_get_battery`

### Build artifacts

- `android_gradle_list_variants`
- `android_gradle_build_variant`
- `android_apk_find`
- `android_apk_hash`
- `android_apk_analyze`
- `android_apk_inspect_manifest`
- `android_apk_inspect_permissions`
- `android_apk_inspect_components`

### Installation and execution

- `android_apk_install`
- `android_apk_uninstall`
- `android_app_launch`
- `android_app_force_stop`
- `android_app_clear_data`
- `android_app_get_pid`
- `android_app_get_version`
- `android_app_update_reinstall`

Uninstall and clear-data operations must require explicit confirmation.

### Instrumentation tests

- `android_tests_list`
- `android_tests_run`
- `android_tests_run_class`
- `android_tests_run_method`
- `android_tests_run_orchestrated`
- `android_tests_get_results`
- `android_tests_get_failures`
- `android_tests_pull_artifacts`

### Device observation

- `android_logcat_start`
- `android_logcat_read`
- `android_logcat_filter`
- `android_logcat_stop`
- `android_device_screenshot`
- `android_device_screen_record`
- `android_device_current_activity`
- `android_device_dump_ui`
- `android_device_get_permissions`
- `android_device_get_network_state`

### Controlled device actions

- `android_device_grant_permission`
- `android_device_revoke_permission`
- `android_device_set_airplane_mode`
- `android_device_rotate`
- `android_device_press_key`
- `android_device_tap`
- `android_device_input_text`

### MotorMark-specific constraints

- Physical device only
- Emulator operations disabled by policy
- No automatic network-state changes without approval
- Logcat must redact motor values, serial numbers, OCR text, URIs, and private paths

---

## 19. Artifact and Binary Inspection

- `vscode_artifact_list`
- `vscode_artifact_hash`
- `vscode_artifact_copy_to_output`
- `vscode_artifact_compare`
- `vscode_artifact_inspect_zip`
- `vscode_artifact_inspect_jar`
- `vscode_artifact_inspect_apk`
- `vscode_artifact_preview_image`
- `vscode_artifact_preview_pdf`
- `vscode_artifact_read_text_report`
- `vscode_artifact_delete_generated`

Useful artifact types include:

- APK files
- Test reports
- Room schema files
- Dependency reports
- Screenshots
- Manifest reports
- Coverage reports

---

## 20. Output Channels and Logs

- `vscode_output_list_channels`
- `vscode_output_read`
- `vscode_output_clear`
- `vscode_output_watch_start`
- `vscode_output_watch_read`
- `vscode_output_watch_stop`
- `vscode_logs_extension_host`
- `vscode_logs_language_server`
- `vscode_logs_tasks`
- `vscode_logs_tests`
- `vscode_logs_debug_adapter`

Large logs should be exposed as pageable resources rather than returned in one oversized response.

---

## 21. File-Watching and Event Tools

- `vscode_watch_files_start`
- `vscode_watch_files_read`
- `vscode_watch_files_stop`
- `vscode_watch_diagnostics_start`
- `vscode_watch_tasks_start`
- `vscode_watch_tests_start`
- `vscode_watch_debug_start`
- `vscode_watch_documents_start`
- `vscode_events_subscribe`
- `vscode_events_poll`
- `vscode_events_unsubscribe`

### Useful event types

- File created
- File changed
- File deleted
- Document opened
- Document saved
- Active editor changed
- Diagnostics changed
- Terminal execution completed
- Task completed
- Test completed
- Debug session started
- Debug session stopped
- Git state changed
- Device connected
- Device disconnected

---

## 22. Settings and Configuration Tools

- `vscode_settings_get`
- `vscode_settings_list`
- `vscode_settings_update_workspace`
- `vscode_settings_update_folder`
- `vscode_settings_reset`
- `vscode_configuration_inspect`
- `vscode_launch_list`
- `vscode_launch_validate`
- `vscode_tasks_config_read`
- `vscode_tasks_config_validate`
- `vscode_extensions_recommendations_read`

Global user settings should be read-only by default. Workspace and folder settings may be writable under normal file-edit policy.

---

## 23. Extension Management

### P2 tools

- `vscode_extensions_list`
- `vscode_extensions_get`
- `vscode_extensions_get_status`
- `vscode_extensions_enable`
- `vscode_extensions_disable`
- `vscode_extensions_install`
- `vscode_extensions_uninstall`
- `vscode_extensions_update`
- `vscode_extensions_read_logs`

Install, uninstall, enable, disable, and update operations must require user approval.

---

## 24. Remote and Container Development

### P2 tools

- `vscode_remote_status`
- `vscode_remote_get_type`
- `vscode_remote_list_roots`
- `vscode_remote_translate_path`
- `vscode_remote_execute`
- `vscode_devcontainer_status`
- `vscode_devcontainer_rebuild`
- `vscode_devcontainer_open`
- `vscode_wsl_status`
- `vscode_ssh_status`
- `vscode_codespaces_status`

Policy enforcement must occur where the extension host runs, not only on the local UI machine.

---

## 25. Notebook Support

### P2 tools

- `vscode_notebook_list`
- `vscode_notebook_read`
- `vscode_notebook_get_cells`
- `vscode_notebook_edit_cell`
- `vscode_notebook_insert_cell`
- `vscode_notebook_delete_cell`
- `vscode_notebook_run_cell`
- `vscode_notebook_run_all`
- `vscode_notebook_interrupt`
- `vscode_notebook_select_kernel`
- `vscode_notebook_read_outputs`
- `vscode_notebook_clear_outputs`

---

## 26. User Interaction and Approval

- `vscode_ui_show_information`
- `vscode_ui_show_warning`
- `vscode_ui_show_error`
- `vscode_ui_request_confirmation`
- `vscode_ui_request_input`
- `vscode_ui_show_quick_pick`
- `vscode_ui_show_progress`
- `vscode_ui_cancel_progress`
- `vscode_ui_open_file`
- `vscode_ui_show_diff`

### Approval classes

| Class | Examples |
|---|---|
| Read | Read files, diagnostics, Git status |
| Safe write | Apply a reviewed source patch |
| Execution | Build, test, lint |
| Device write | Install APK, grant permission |
| Destructive | Delete, uninstall, clear data, discard changes |
| External | Network access, fetch, pull, push |
| Privileged | `sudo`, system settings, protected device operations |

---

## 27. Security Requirements

### 27.1 Path security

- Canonical-path validation
- Workspace containment
- Symlink escape prevention
- Protected-path rules
- File-size limits
- Binary-type validation
- Multi-root disambiguation

### 27.2 Secret protection

Automatically redact:

- Tokens
- API keys
- Passwords
- Private keys
- Signing credentials
- `.env` secrets
- Gradle credentials
- Android keystore passwords
- Cloud credentials

Protected files should require explicit policy entries rather than being readable by default.

### 27.3 Command security

- Structured executable and argument arrays
- Restricted working directories
- Environment-variable allowlist
- Timeouts
- Output caps
- Cancellation
- Child-process cleanup
- Network permission classification
- No automatic `sudo`
- No arbitrary shell interpolation by default

### 27.4 Write security

- Expected file hash or document version
- Dry-run mode
- Diff preview
- Atomic edits
- Undo token
- Dirty-buffer detection
- No hidden overwrite
- No destructive Git operation without approval

---

## 28. Reliability Requirements

Every tool should provide:

- Stable machine-readable error codes
- Human-readable error message
- Cancellation token
- Timeout
- Pagination
- Output truncation indicator
- Retryability indicator
- Idempotency key for safe retries
- Operation ID
- Start timestamp
- Completion timestamp
- Workspace root
- Partial-success reporting
- Resource URI for large output
- Schema version

### Recommended error codes

```text
not-connected
workspace-not-found
ambiguous-workspace
access-denied
workspace-untrusted
file-not-found
file-changed
dirty-buffer-conflict
invalid-path
symlink-escape
command-not-allowed
command-timeout
command-failed
terminal-unavailable
task-not-found
test-failed
device-not-found
device-unauthorized
device-locked
debug-session-not-running
output-truncated
operation-cancelled
```

---

## 29. Minimum Upgrade Required for MotorMark

The following tools are the minimum practical upgrade needed to continue MotorMark development without external manual execution.

### 29.1 File modification

- `vscode_workspace_preview_edit`
- `vscode_workspace_apply_patch`
- `vscode_workspace_apply_text_edits`
- `vscode_workspace_write_file`
- `vscode_workspace_create_file`
- `vscode_editor_save_all`

### 29.2 Execution

- `vscode_terminal_execute`
- `vscode_terminal_read_output`
- `vscode_terminal_cancel_execution`
- `vscode_tasks_list`
- `vscode_tasks_run`
- `vscode_tasks_read_output`

### 29.3 Validation

- `vscode_tests_run`
- `vscode_tests_get_results`
- `vscode_tests_get_failures`
- `vscode_quality_run_all`
- `vscode_diagnostics_wait_for_stable`

### 29.4 Git

- `vscode_scm_status`
- `vscode_scm_diff`
- `vscode_scm_diff_file`

### 29.5 Android physical device

- `android_adb_list_devices`
- `android_adb_wait_for_device`
- `android_device_is_unlocked`
- `android_apk_install`
- `android_tests_run`
- `android_tests_get_results`
- `android_logcat_start`
- `android_logcat_read`
- `android_logcat_stop`

With these tools, the interface can:

1. Correct the MIME fallback.
2. Compile the change.
3. Run host quality gates.
4. Detect the physical device.
5. Install the APK.
6. Run instrumentation tests.
7. Inspect failures.
8. Update the tracker with real evidence.

---

## 30. Recommended Implementation Order

### Milestone 1 — Safe editing

- Patch preview
- Atomic patch application
- File writing
- Dirty-buffer detection
- Save support
- Undo support

### Milestone 2 — Controlled execution

- Structured command execution
- Terminal output
- Exit codes
- Timeout and cancellation
- Task execution

### Milestone 3 — Validation

- Test discovery and execution
- Quality-gate execution
- Diagnostics stabilization
- Artifact discovery

### Milestone 4 — Source control

- Git status
- Diffs
- Staging
- Commit support
- Protected destructive actions

### Milestone 5 — Android physical-device support

- ADB discovery
- Device authorization and lock status
- APK installation
- Instrumentation tests
- Logcat
- Screenshots and UI dumps

### Milestone 6 — Full IDE intelligence

- Definitions and references
- Rename
- Code actions
- Refactors
- Formatting
- Organize imports

### Milestone 7 — Advanced platform support

- Debugger control
- Remote development
- Containers
- Extension management
- Notebooks
- Event subscriptions

---

## 31. Acceptance Criteria

The connected VS Code interface is considered development-complete when it can safely perform this workflow:

```text
1. Discover the workspace.
2. Read project documentation and source.
3. Inspect diagnostics.
4. Preview a multi-file patch.
5. Apply the patch atomically.
6. Save all affected documents.
7. Format the changed files.
8. Run project quality gates.
9. Run unit and integration tests.
10. Inspect failures with source locations and output.
11. Review Git diff.
12. Detect and validate a physical Android device.
13. Install the APK.
14. Run instrumentation tests.
15. Collect device logs and test artifacts.
16. Update project evidence and tracker files.
17. Commit the validated change with explicit approval.
```

The interface must complete this without:

- Overwriting unsaved user changes
- Escaping the workspace
- Exposing secrets
- Running unapproved destructive commands
- Hiding partial failures
- Claiming validation that was not actually executed
