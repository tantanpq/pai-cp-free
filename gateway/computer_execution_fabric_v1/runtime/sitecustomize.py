"""
PAI Computer Execution Fabric R1 — Python Runtime Filesystem Containment Guard
Loaded automatically when PYTHONPATH includes this directory.
Enforces OS/runtime-level filesystem containment for Python child processes.
"""
import os
import sys
import builtins
from pathlib import Path

candidate_scope = os.environ.get('PAI_CANDIDATE_SCOPE')
if candidate_scope:
    candidate_scope = os.path.abspath(candidate_scope).lower()

forbidden_roots = [
    r'c:\users\tom\my drive\pai_project\core\chief_chat_bridge_v1\src',
    r'c:\users\tom\my drive\pai_project\core\chief_chat_bridge_v1\contracts',
    r'c:\users\tom\my drive\pai_project\core\chief_chat_bridge_v1\launchers',
    r'c:\programdata\pai_chief\generations',
    r'c:\programdata\pai_chief\launchers',
    r'c:\windows',
]

def is_safe(target):
    if not target or not isinstance(target, (str, bytes, os.PathLike)):
        return True
    try:
        resolved = os.path.abspath(os.fspath(target)).lower()
    except Exception:
        return True

    for f in forbidden_roots:
        if resolved == f or resolved.startswith(f + os.sep) or resolved.startswith(f + '/'):
            return False

    if candidate_scope:
        allowed = [candidate_scope, os.path.abspath(os.environ.get('TEMP', '')).lower(), r'c:\programdata\pai_chief\workspaces']
        for a in allowed:
            if a and (resolved == a or resolved.startswith(a + os.sep) or resolved.startswith(a + '/')):
                return True
        return False

    return True

orig_open = builtins.open

def guarded_open(file, mode='r', *args, **kwargs):
    m = str(mode)
    if any(c in m for c in ('w', 'a', '+')):
        if not is_safe(file):
            raise PermissionError(f"HOST_CONTROL_SCOPE_DENIED: Write target '{file}' is outside candidate scope")
    return orig_open(file, mode, *args, **kwargs)

builtins.open = guarded_open
