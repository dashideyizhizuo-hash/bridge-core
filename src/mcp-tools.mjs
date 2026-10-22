// Explicit public tools. Gateway authorization remains authoritative.
export const MCP_TOOL_DEFINITIONS = [
  {
    "name": "bridge.list_hosts",
    "title": "List connected computers",
    "description": "List the authenticated account's registered Bridge Hosts and reported execution state. Registration alone does not prove a live connection. Returns logical Host IDs, never physical filesystem roots. No repository or GitHub authorization is required.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    }
  },
  {
    "name": "bridge.create_host_pairing",
    "title": "Prepare computer pairing",
    "description": "Create a short-lived pairing capability for a new Bridge Host owned by the authenticated account. The official local Host client must claim it to finish pairing. This grants new access; do not create another identity to diagnose an already paired Host. Never expose the returned pairing capability in chat or logs.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ttlSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 1800,
          "description": "Defaults to 600 seconds."
        }
      }
    }
  },
  {
    "name": "bridge.pause_host",
    "title": "Pause computer execution",
    "description": "Disable execution for one owned Direct Host. Running Direct work is fenced by subsequent Host heartbeats; completed actions are not undone. This does not stop a separate GitHub Actions runner or cancel already submitted GitHub jobs.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "hostId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[A-Za-z0-9_.-]{1,128}$"
        }
      },
      "required": [
        "hostId"
      ]
    }
  },
  {
    "name": "bridge.resume_host",
    "title": "Resume computer execution",
    "description": "Enable execution for one owned Direct Host under its existing local policy. Resuming permits future task claims; it does not prove the Host is online, start its local service, or grant GitHub repository access.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "hostId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[A-Za-z0-9_.-]{1,128}$"
        }
      },
      "required": [
        "hostId"
      ]
    }
  },
  {
    "name": "bridge.run_host_command",
    "title": "Run a command on a computer",
    "description": "Run one bounded argv command on the explicitly chosen owned Host under its existing OS identity and local policy. Commands can change files and access the internet. No GitHub repository or workflow is required. Waits up to 10 seconds by default; a timeout or disconnect does not cancel or repeat execution. Keep the returned runId and query its status/result. File input/output uses only the declared managed asset/export placeholders; shell built-ins require an explicit shell executable.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "hostId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128,
          "pattern": "^[A-Za-z0-9_.-]{1,128}$"
        },
        "argv": {
          "type": "array",
          "minItems": 1,
          "maxItems": 64,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192,
            "pattern": "^[^\\u0000]+$"
          },
          "description": "Executable followed by separate argv entries, capped at 65536 UTF-8 bytes. Put each {asset:N} or {export:N} in its own argv entry, never inside script text. Scripts can instead read BRIDGE_ASSET_0 / BRIDGE_EXPORT_0 from the environment (PowerShell: $env:BRIDGE_ASSET_0 / $env:BRIDGE_EXPORT_0). Emit UTF-8 output."
        },
        "cwd": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1024,
          "pattern": "^(?!/)(?![A-Za-z]:)(?!\\./)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\\\\\u0000\\r\\n]).+$",
          "description": "A path relative to the locally configured Host root, never an absolute host path."
        },
        "timeoutSeconds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 3600
        },
        "waitSeconds": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10,
          "description": "Defaults to 10. Zero returns immediately. This is a response wait window, not the execution timeout."
        },
        "assets": {
          "type": "array",
          "minItems": 1,
          "maxItems": 8,
          "items": {
            "type": "string",
            "minLength": 14,
            "maxLength": 166,
            "pattern": "^asset-[A-Za-z0-9_-]{8,160}$"
          },
          "uniqueItems": true
        },
        "exports": {
          "type": "array",
          "minItems": 1,
          "maxItems": 8,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "fileName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^(?!\\.{1,2}$)[^/\\\\\\u0000]+$",
                "description": "A filename, not a path. The backend also enforces the 255-byte UTF-8 limit."
              },
              "mimeType": {
                "type": "string",
                "minLength": 3,
                "maxLength": 192,
                "pattern": "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$"
              },
              "maxBytes": {
                "type": "integer",
                "minimum": 1,
                "maximum": 26214400
              },
              "required": {
                "type": "boolean",
                "description": "Defaults to true. Missing required output fails the task."
              }
            },
            "required": [
              "fileName",
              "mimeType"
            ]
          }
        }
      },
      "required": [
        "hostId",
        "argv"
      ]
    }
  },
  {
    "name": "bridge.import_file",
    "title": "Import an attached file",
    "description": "Import one actual ChatGPT attachment through the native file parameter into the authenticated account's temporary private transfer store. Use its returned asset ID as a managed Host input. Public HTTPS file-delivery domains need no per-domain configuration; private network targets, URL credentials and nonstandard ports are rejected. Files are at most 25 MiB; native imports normally expire after 24 hours. Use the returned expiry and never invent a download URL.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "file": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "download_url": {
              "type": "string"
            },
            "file_id": {
              "type": "string"
            },
            "mime_type": {
              "type": "string"
            },
            "file_name": {
              "type": "string"
            }
          },
          "required": [
            "download_url",
            "file_id"
          ]
        },
        "ttlSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 86400,
          "description": "Temporary transfer lifetime. Use the returned expiry; new permanent storage is not supported."
        }
      },
      "required": [
        "file"
      ]
    },
    "_meta": {
      "openai/fileParams": [
        "file"
      ]
    }
  },
  {
    "name": "bridge.create_file_upload",
    "title": "Prepare a temporary file upload",
    "description": "Create a principal-owned upload ticket for a known file with an exact byte length and SHA-256. The caller must deliver the bytes through the returned protected upload mechanism; the ticket alone does not prove a READY file. New uploads are temporary, at most 25 MiB. Keep the upload credential out of chat and logs, and use the actual returned expiry.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "fileName": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255,
          "pattern": "^(?!\\.{1,2}$)[^/\\\\\\u0000]+$",
          "description": "A filename, not a path. The backend also enforces the 255-byte UTF-8 limit."
        },
        "mimeType": {
          "type": "string",
          "minLength": 3,
          "maxLength": 192,
          "pattern": "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$"
        },
        "sizeBytes": {
          "type": "integer",
          "minimum": 1,
          "maximum": 26214400
        },
        "sha256": {
          "type": "string",
          "minLength": 64,
          "maxLength": 64,
          "pattern": "^[0-9a-f]{64}$"
        },
        "ttlSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 86400,
          "description": "Temporary transfer lifetime. Use the returned expiry; new permanent storage is not supported."
        }
      },
      "required": [
        "fileName",
        "mimeType",
        "sizeBytes",
        "sha256"
      ]
    }
  },
  {
    "name": "bridge.delete_file",
    "title": "Delete a stored permanent file",
    "description": "Permanently delete one existing, owned permanent Bridge file. The current backend only permits this operation for previously stored permanent files; temporary imports/exports expire under their own retention rules. This does not delete files on a Host or erase execution receipts. Confirm the exact asset before deletion.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "assetId": {
          "type": "string",
          "minLength": 14,
          "maxLength": 166,
          "pattern": "^asset-[A-Za-z0-9_-]{8,160}$"
        }
      },
      "required": [
        "assetId"
      ]
    }
  },
  {
    "name": "bridge.get_repository_configuration",
    "title": "Inspect repository configuration",
    "description": "Read the trusted default-branch Bridge policy for one explicitly chosen authorized GitHub repository. Report the actual policy ref/SHA, runner classes and configured execution/editing controls. This is configuration inspection, not proof that a runner is online or that a job succeeded. Missing GitHub connection, saved selection or project policy remains an error; this tool never installs or bypasses it.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repository": {
          "type": "string",
          "minLength": 3,
          "maxLength": 256,
          "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        }
      },
      "required": [
        "repository"
      ]
    }
  },
  {
    "name": "bridge.execute_repository_commands",
    "title": "Run repository commands",
    "description": "Run 1–16 ordered argv commands in one repository workspace at a pinned target, subject to trusted project/host workspace-execution policy. Commands may modify that workspace or access approved resources and the internet. This does not produce a publishable candidate. Only command records are accepted; no preset names, edit operations or publication steps. After a Run ID is returned, query that same Run. Do not resubmit merely to retrieve output.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repository": {
          "type": "string",
          "minLength": 3,
          "maxLength": 256,
          "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
        },
        "targetRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255,
          "pattern": "^[^\\u0000\\r\\n]+$"
        },
        "targetSha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$",
          "description": "Optional exact target precondition. If omitted, the server resolves and pins the target before admitting execution."
        },
        "expectedPolicySha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$",
          "description": "Exact trusted policy SHA returned by repository configuration. Changed policy fails closed instead of silently selecting a new recipe or authority."
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        },
        "commands": {
          "type": "array",
          "minItems": 1,
          "maxItems": 16,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 64,
                "pattern": "^[A-Za-z][A-Za-z0-9._-]{0,63}$"
              },
              "argv": {
                "type": "array",
                "minItems": 1,
                "maxItems": 64,
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4096,
                  "pattern": "^[^\\u0000]+$"
                },
                "description": "Executable and separate arguments. Each entry is also limited to 4096 UTF-8 bytes and all entries together to 32768 bytes."
              },
              "cwd": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "pattern": "^(?!/)(?![A-Za-z]:)(?!\\./)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\\\\\u0000\\r\\n]).+$"
              },
              "resources": {
                "type": "array",
                "minItems": 0,
                "maxItems": 16,
                "items": {
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 64,
                  "pattern": "^[a-z][a-z0-9.-]{1,63}$"
                },
                "uniqueItems": true,
                "description": "Only logical resources granted by trusted project and host policy. Never physical host paths."
              },
              "timeoutSeconds": {
                "type": "integer",
                "minimum": 1,
                "maximum": 3600
              }
            },
            "required": [
              "id",
              "argv"
            ]
          },
          "description": "Command IDs must be unique. The backend also enforces the 262144-byte compact batch request ceiling and narrower project/host limits."
        }
      },
      "required": [
        "repository",
        "targetRef",
        "expectedPolicySha",
        "commands"
      ]
    }
  },
  {
    "name": "bridge.verify_repository",
    "title": "Verify repository code",
    "description": "Run the fixed verification recipe explicitly configured in the trusted default-branch project policy against the pinned target. This starts stateful runner work and may execute project code. It does not edit or publish repository changes. A missing, stale or invalid recipe fails closed. The caller cannot choose a capability, supply arbitrary parameters, replace the recipe or skip its checks. Inspect the actual run result; successful verification alone does not authorize publication.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repository": {
          "type": "string",
          "minLength": 3,
          "maxLength": 256,
          "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
        },
        "targetRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255,
          "pattern": "^[^\\u0000\\r\\n]+$"
        },
        "targetSha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$",
          "description": "Optional exact target precondition. If omitted, the server resolves and pins the target before admitting execution."
        },
        "expectedPolicySha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$",
          "description": "Exact trusted policy SHA returned by repository configuration. Changed policy fails closed instead of silently selecting a new recipe or authority."
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        }
      },
      "required": [
        "repository",
        "targetRef",
        "expectedPolicySha"
      ]
    }
  },
  {
    "name": "bridge.edit_and_verify_repository",
    "title": "Edit and verify repository changes",
    "description": "Apply bounded text edits to existing tracked files on an allowed existing target branch, then execute the fixed trusted verification recipe. Project and host policy must permit the exact paths, runner identity and limits; protected configuration paths cannot be edited. Verification cannot be omitted or selected by the caller. Returns a VERIFIED candidate only when trusted checks succeed. Changes are not published by this tool; publish is a separate explicit operation. A missing or stale recipe fails closed.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repository": {
          "type": "string",
          "minLength": 3,
          "maxLength": 256,
          "pattern": "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"
        },
        "targetRef": {
          "type": "string",
          "minLength": 1,
          "maxLength": 255,
          "pattern": "^[^\\u0000\\r\\n]+$"
        },
        "targetSha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$",
          "description": "Optional exact target precondition. If omitted, the server resolves and pins the target before admitting execution."
        },
        "expectedPolicySha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$",
          "description": "Exact trusted policy SHA returned by repository configuration. Changed policy fails closed instead of silently selecting a new recipe or authority."
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        },
        "operations": {
          "type": "array",
          "minItems": 1,
          "maxItems": 64,
          "items": {
            "type": "object",
            "oneOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "replace-exact"
                  },
                  "path": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512,
                    "pattern": "^(?!/)(?![A-Za-z]:)(?!\\./)(?!(?:\\.git|\\.github|\\.bridge)(?:/|$))(?!\\.gitmodules$)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[\\\\\\u0000\\r\\n]).+$"
                  },
                  "oldText": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2097152
                  },
                  "newText": {
                    "type": "string",
                    "minLength": 0,
                    "maxLength": 2097152
                  }
                },
                "required": [
                  "type",
                  "path",
                  "oldText",
                  "newText"
                ]
              },
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "type": {
                    "type": "string",
                    "const": "apply-patch"
                  },
                  "patch": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2097152
                  }
                },
                "required": [
                  "type",
                  "patch"
                ]
              }
            ],
            "description": "Only modifications to existing tracked text files within trusted allowed paths. Runtime checks still reject protected paths, binary files, symlinks, additions, deletions, mode changes, stale or ambiguous replacement text, and excess byte budgets."
          }
        },
        "commitSubject": {
          "type": "string",
          "minLength": 3,
          "maxLength": 120,
          "pattern": "^[^\\r\\n\\u0000]*$"
        }
      },
      "required": [
        "repository",
        "targetRef",
        "expectedPolicySha",
        "operations",
        "commitSubject"
      ]
    }
  },
  {
    "name": "bridge.get_run",
    "title": "Get task status",
    "description": "Retrieve the owned run's normalized state and exact identity without re-executing it. Supports Host commands, temporary file transfers and GitHub engineering tasks. In a durable task session this also renews the active stage lease. Queued/running is not success, and an interrupted read does not cancel the submitted work.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "minLength": 8,
          "maxLength": 256,
          "pattern": "^[^\\u0000\\r\\n]+$"
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        }
      },
      "required": [
        "runId"
      ]
    }
  },
  {
    "name": "bridge.get_result",
    "title": "Get task results and output files",
    "description": "Retrieve bounded evidence for one owned completed run or READY transferred file. Temporary output files may include principal-bound MCP resource links; use only actual returned links and expiry. In a durable task session this also renews its lease. RESULT_NOT_READY means inspect/wait for the same run, not submit it again. Expired files do not erase retained command evidence.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "minLength": 8,
          "maxLength": 256,
          "pattern": "^[^\\u0000\\r\\n]+$"
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        }
      },
      "required": [
        "runId"
      ]
    }
  },
  {
    "name": "bridge.publish",
    "title": "Publish verified repository changes",
    "description": "Publish the exact candidate from an already VERIFIED owned GitHub edit run or verified edited workflow, subject to current repository authorization, trusted policy and target identity. Direct Host commands and transferred files are never publishable. Publication can change a remote repository; it must not be inferred from successful verification. A stale target is rejected rather than force-overwritten.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "runId": {
          "type": "string",
          "minLength": 8,
          "maxLength": 256,
          "pattern": "^[^\\u0000\\r\\n]+$"
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        }
      },
      "required": [
        "runId"
      ]
    }
  },
  {
    "name": "bridge.task_transition",
    "title": "Finish a durable task stage",
    "description": "After persisting the matching durable GitHub checkpoint or blocker, atomically release the active task stage as READY, BLOCKED or DONE. An active fenced task session is required. READY and DONE require the exact checkpoint SHA and state-comment ID. BLOCKED requires only its stable reason code. Only READY can request continuation to another stage.",
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "outcome": {
          "type": "string",
          "enum": [
            "READY",
            "BLOCKED",
            "DONE"
          ]
        },
        "checkpointSha": {
          "type": "string",
          "minLength": 40,
          "maxLength": 40,
          "pattern": "^[0-9a-f]{40}$"
        },
        "stateCommentId": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9007199254740991
        },
        "continue": {
          "type": "boolean"
        },
        "reasonCode": {
          "type": "string",
          "minLength": 3,
          "maxLength": 64,
          "pattern": "^[A-Z][A-Z0-9_]{2,63}$"
        },
        "taskSessionToken": {
          "type": "string",
          "pattern": "^bts_[A-Za-z0-9_-]{43,128}$",
          "description": "Use only the current issued durable task session token when required. Never fabricate one or print it in user-facing output."
        }
      },
      "required": [
        "outcome"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "outcome": {
                "const": "BLOCKED"
              }
            },
            "required": [
              "outcome"
            ]
          },
          "then": {
            "required": [
              "reasonCode"
            ],
            "not": {
              "anyOf": [
                {
                  "required": [
                    "checkpointSha"
                  ]
                },
                {
                  "required": [
                    "stateCommentId"
                  ]
                },
                {
                  "required": [
                    "continue"
                  ]
                }
              ]
            }
          },
          "else": {
            "required": [
              "checkpointSha",
              "stateCommentId"
            ],
            "not": {
              "required": [
                "reasonCode"
              ]
            }
          }
        },
        {
          "if": {
            "properties": {
              "outcome": {
                "const": "DONE"
              }
            },
            "required": [
              "outcome"
            ]
          },
          "then": {
            "properties": {
              "continue": {
                "const": false
              }
            }
          }
        }
      ]
    }
  },
  {
    "name": "bridge.repository_tools_status",
    "title": "Check repository tool availability",
    "description": "Read the exposure status of already declared repository preset tools, including missing policy or catalog limits. This grants no repository access and never executes a preset. Ordinary Host and file operations remain available when repository integration is unavailable.",
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "openWorldHint": false
    },
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {}
    }
  }
];
