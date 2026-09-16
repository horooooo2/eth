"""Import / export round-trip tests."""
from __future__ import annotations

import json
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.character.card import CharacterCardError, load_character
from src.character.exporter import export_to_json
from src.character.importer import import_from_json

CONFIG = ROOT / "config"


def test_export_then_import() -> None:
    tmp = Path(tempfile.mkdtemp())
    (tmp / "characters").mkdir()
    text = export_to_json("zhangming", CONFIG)
    card = json.loads(text)
    card["id"] = "zhangming_copy"
    path = import_from_json(json.dumps(card, ensure_ascii=False), tmp)
    loaded = load_character("zhangming_copy", tmp)
    assert loaded["name"] == card["name"]
    assert loaded["decision_rules"]["base_threshold"] == card["decision_rules"]["base_threshold"]
    assert path.exists()


def test_import_invalid_json() -> None:
    tmp = Path(tempfile.mkdtemp())
    try:
        import_from_json("{bad", tmp)
        raise AssertionError("expected error")
    except CharacterCardError:
        pass


def test_import_missing_field() -> None:
    tmp = Path(tempfile.mkdtemp())
    try:
        import_from_json('{"id":"a","name":"n"}', tmp)
        raise AssertionError("expected error")
    except CharacterCardError:
        pass


def test_no_overwrite_without_force() -> None:
    """Legacy path: replace_all=False still requires force to overwrite same id."""
    tmp = Path(tempfile.mkdtemp())
    text = export_to_json("zhangming", CONFIG)
    card = json.loads(text)
    card["id"] = "roundtrip_x"
    import_from_json(json.dumps(card), tmp, replace_all=False)
    try:
        import_from_json(json.dumps(card), tmp, force=False, replace_all=False)
        raise AssertionError("expected error")
    except CharacterCardError:
        pass
    import_from_json(json.dumps(card), tmp, force=True, replace_all=False)


def test_single_character_replace_all() -> None:
    """Default import keeps only one card per owner."""
    from src.character.card import list_characters

    tmp = Path(tempfile.mkdtemp())
    text = export_to_json("zhangming", CONFIG)
    a = json.loads(text)
    a["id"] = "char_a"
    a["name"] = "A"
    b = json.loads(text)
    b["id"] = "char_b"
    b["name"] = "B"
    import_from_json(json.dumps(a), tmp, owner="user1")
    import_from_json(json.dumps(b), tmp, owner="user1")
    items = list_characters(tmp, "user1")
    assert len(items) == 1
    assert items[0]["id"] == "char_b"
    # Different account keeps its own card
    import_from_json(json.dumps(a), tmp, owner="user2")
    assert len(list_characters(tmp, "user1")) == 1
    assert list_characters(tmp, "user2")[0]["id"] == "char_a"


def main() -> None:
    tests = [
        test_export_then_import,
        test_import_invalid_json,
        test_import_missing_field,
        test_no_overwrite_without_force,
        test_single_character_replace_all,
    ]
    failed = 0
    for fn in tests:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(failed)


if __name__ == "__main__":
    main()
