import json
from pathlib import Path

from model_service.extract import HeuristicExtractor

GOLDEN = Path(__file__).parent / "golden" / "heuristic_extract.json"


def test_heuristic_extraction_matches_the_golden_output() -> None:
    golden = json.loads(GOLDEN.read_text())
    extractor = HeuristicExtractor()
    for case in golden:
        facts = extractor.extract(case["text"])
        assert [{"text": f.text, "kind": f.kind} for f in facts] == case["facts"], case["text"]


def test_heuristic_extraction_names_its_model() -> None:
    assert HeuristicExtractor().model_id == "heuristic-sentences@1"
