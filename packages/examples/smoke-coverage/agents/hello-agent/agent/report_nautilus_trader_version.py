# Imports NautilusTrader from the venv the base layer installs, and prints its
# version. A file in the run's cwd, since the read fence denies inline code
# (`python -c`) in dontAsk mode.
import nautilus_trader

print(nautilus_trader.__version__)
