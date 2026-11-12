"""Mobile snapshot: one JSON file with the numbers a phone app shows at a glance.

``just mobile-snapshot`` reads the ledger at ``$LEDGER_DIR`` and the personal inputs in
``$LEDGER_DIR/config/mobile.yaml`` (see ``mobile.example.yaml`` beside this
package) and writes ``$LEDGER_DIR/mobile/snapshot.json``.
"""

from beancount_tooling.mobile.config import (
    MobileConfig,
    MobileConfigError,
    load_config,
    parse_config,
)
from beancount_tooling.mobile.snapshot import SCHEMA_VERSION, build_snapshot

__all__ = [
    "SCHEMA_VERSION",
    "MobileConfig",
    "MobileConfigError",
    "build_snapshot",
    "load_config",
    "parse_config",
]
