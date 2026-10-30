"""`uv run python -m evals.download`: fetch the datasets into python/evals/data/."""

from .data import download

if __name__ == "__main__":
    for path in download():
        print(path)
