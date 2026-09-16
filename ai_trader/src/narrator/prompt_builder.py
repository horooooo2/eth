"""Load and render external prompt templates from config/prompts."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


class PromptConfigError(Exception):
    """Raised when prompt files are missing, empty, or malformed."""


_PLACEHOLDER_RE = re.compile(r"\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}")
_BAD_BRACE_RE = re.compile(r"(?<!\{)\{[a-zA-Z_][a-zA-Z0-9_]*\}(?!\})")


class PromptBuilder:
    """Load prompt markdown files and render {{variable}} placeholders."""

    def __init__(
        self,
        prompts_dir: Path,
        *,
        required_files: list[str] | None = None,
        optional_files: list[str] | None = None,
    ) -> None:
        self.prompts_dir = Path(prompts_dir)
        self.required_files = list(
            required_files
            or ["system.md", "user_decision.md", "user_event.md"]
        )
        self.optional_files = list(
            optional_files
            or ["user_daily_open.md", "user_daily_close.md"]
        )
        self._validate_required()
        self.templates = self._load_all_templates()
        self.version = self._compute_prompts_hash()

    def _validate_required(self) -> None:
        if not self.prompts_dir.is_dir():
            raise PromptConfigError(f"prompts dir missing: {self.prompts_dir}")
        for name in self.required_files:
            path = self.prompts_dir / name
            if not path.exists():
                raise PromptConfigError(f"required prompt missing: {name}")
            text = path.read_text(encoding="utf-8").strip()
            if not text:
                raise PromptConfigError(f"required prompt empty: {name}")
            self._validate_placeholders(name, text)

    @staticmethod
    def _validate_placeholders(name: str, text: str) -> None:
        """Ensure placeholders use {{name}}; reject single-brace forms."""
        # Allow double-brace; flag lone {name} that is not part of {{name}}
        stripped = _PLACEHOLDER_RE.sub("", text)
        bad = _BAD_BRACE_RE.findall(stripped)
        if bad:
            raise PromptConfigError(
                f"invalid placeholder in {name}: use {{{{name}}}} not single braces "
                f"(found {bad[:3]})"
            )

    def _load_all_templates(self) -> dict[str, str]:
        templates: dict[str, str] = {}
        for path in sorted(self.prompts_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            if not text.strip() and path.name in self.required_files:
                raise PromptConfigError(f"required prompt empty: {path.name}")
            if text.strip():
                self._validate_placeholders(path.name, text)
            templates[path.stem] = text
        return templates

    def _compute_prompts_hash(self) -> str:
        payload = json.dumps(self.templates, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:8]

    def render(self, template_name: str, variables: dict[str, Any]) -> str:
        """
        Render template with {{key}} replacement.
        Missing keys become empty strings; unknown placeholders left empty.
        """
        template = self.templates.get(template_name, "")
        # First replace provided variables
        for key, value in variables.items():
            template = template.replace(f"{{{{{key}}}}}", str(value))
        # Clear any remaining {{placeholders}}
        template = _PLACEHOLDER_RE.sub("", template)
        return template

    def build_decision_prompt(self, **kwargs: Any) -> tuple[str, str]:
        """Return (system_prompt, user_prompt) for a decision scene."""
        system = self.templates.get("system", "")
        user = self.render("user_decision", kwargs)
        return system, user

    def build_event_prompt(self, **kwargs: Any) -> tuple[str, str]:
        """Return (system_prompt, user_prompt) for an event scene."""
        system = self.templates.get("system", "")
        user = self.render("user_event", kwargs)
        return system, user

    def build_daily_open_prompt(self, **kwargs: Any) -> tuple[str, str]:
        system = self.templates.get("system", "")
        user = self.render("user_daily_open", kwargs)
        return system, user

    def build_daily_close_prompt(self, **kwargs: Any) -> tuple[str, str]:
        system = self.templates.get("system", "")
        user = self.render("user_daily_close", kwargs)
        return system, user

    @classmethod
    def from_narrator_config(cls, config_path: Path, project_root: Path) -> PromptBuilder:
        """Construct from narrator_config.json prompts section."""
        data = json.loads(Path(config_path).read_text(encoding="utf-8"))
        prompts = data.get("prompts") or {}
        rel = prompts.get("dir", "config/prompts")
        prompts_dir = Path(rel)
        if not prompts_dir.is_absolute():
            prompts_dir = project_root / prompts_dir
        return cls(
            prompts_dir,
            required_files=list(prompts.get("required_files") or []),
            optional_files=list(prompts.get("optional_files") or []),
        )
