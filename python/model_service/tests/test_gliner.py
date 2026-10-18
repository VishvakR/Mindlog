from dataclasses import dataclass

import numpy as np
from model_service.gliner import build_inputs, decode_spans, split_words


@dataclass
class FakeEncoding:
    ids: list[int]
    word_ids: list[int | None]


class FakeTokenizer:
    """Two subtokens for words longer than 4 characters, one otherwise; [CLS]/[SEP] around."""

    def encode(
        self,
        sequence: list[str],
        pair: None = None,
        is_pretokenized: bool = True,
        add_special_tokens: bool = True,
    ) -> FakeEncoding:
        assert is_pretokenized
        words = sequence
        ids = [1]
        word_ids: list[int | None] = [None]
        for w, word in enumerate(words):
            for _ in range(2 if len(word) > 4 else 1):
                ids.append(100 + w)
                word_ids.append(w)
        ids.append(2)
        word_ids.append(None)
        return FakeEncoding(ids, word_ids)


def test_split_words_keeps_character_offsets() -> None:
    words = split_words("Alice met Bob-Smith, in Paris.")
    assert [w.text for w in words] == ["Alice", "met", "Bob-Smith", ",", "in", "Paris", "."]
    assert all("Alice met Bob-Smith, in Paris."[w.start : w.end] == w.text for w in words)


def test_inputs_mask_the_prompt_and_mark_first_subtokens() -> None:
    words = split_words("Alice works here")
    inputs = build_inputs(FakeTokenizer(), words, ["person"], max_width=2)
    # prompt: <<ENT>> person <<SEP>> -> words 0..2; text words start at 3
    mask = inputs["words_mask"][0].tolist()
    word_ids = (
        FakeTokenizer().encode(["<<ENT>>", "person", "<<SEP>>", "Alice", "works", "here"]).word_ids
    )
    expected = []
    seen: set[int] = set()
    for w in word_ids:
        if w is None or w < 3 or w in seen:
            expected.append(0)
        else:
            seen.add(w)
            expected.append(w - 3 + 1)
    assert mask == expected
    assert inputs["text_lengths"].tolist() == [[3]]
    assert inputs["span_idx"][0].tolist() == [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2], [2, 3]]
    assert inputs["span_mask"][0].tolist() == [True, True, True, True, True, False]
    assert inputs["input_ids"].dtype == np.int64


def test_decoding_keeps_the_best_non_overlapping_spans() -> None:
    text = "Alice works at Acme Corp"
    words = split_words(text)
    logits = np.full((len(words), 3, 2), -10.0, dtype=np.float32)
    logits[0, 0, 0] = 4.0  # "Alice" person
    logits[3, 1, 1] = 3.0  # "Acme Corp" organization
    logits[3, 0, 1] = 1.0  # "Acme" organization, overlaps and scores lower
    spans = decode_spans(logits, words, text, ["person", "organization"], threshold=0.5)
    assert [(s.text, s.label) for s in spans] == [
        ("Alice", "person"),
        ("Acme Corp", "organization"),
    ]
    assert spans[0].start == 0 and spans[1].end == len(text)
    assert 0.5 < spans[1].score < 1.0
