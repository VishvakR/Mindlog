import numpy as np
import numpy.typing as npt
from model_service.summarize import ExtractiveSummarizer, fit, sentences


class TopicEmbedder:
    """Sentences about Ana point one way, the rest another."""

    model_id = "topic@1"

    def embed(self, texts: list[str], kind: str) -> npt.NDArray[np.float32]:
        return np.array([[1.0, 0.0] if "Ana" in t else [0.0, 1.0] for t in texts], np.float32)


def test_sentences_are_distinct_and_in_order() -> None:
    assert sentences(["A b. C d!", "a b. E"]) == ["A b.", "C d!", "E"]


def test_fit_cuts_a_lone_long_sentence() -> None:
    assert fit(["x" * 50], 10) == "x" * 10
    assert fit(["one.", "two.", "three."], 9) == "one. two."


def test_centroid_keeps_the_central_topic_in_original_order() -> None:
    s = ExtractiveSummarizer(TopicEmbedder())
    texts = ["Ana lives in Lisbon. The weather was odd.", "Ana works at Acme. Ana likes tea."]
    out = s.summarize(texts, "Summarize.", 60)
    assert out == "Ana lives in Lisbon. Ana works at Acme. Ana likes tea."


def test_without_an_embedder_it_takes_lead_sentences() -> None:
    s = ExtractiveSummarizer(None)
    assert s.model_id == "lead-sentences@1"
    assert s.summarize(["First one. Second one."], "", 12) == "First one."
