# Wake word models

`melspectrogram.onnx`, `embedding_model.onnx` and `hey_jarvis_v0.1.onnx` are
the pre-trained models from openWakeWord by David Scripka, release v0.5.1:
https://github.com/dscripka/openWakeWord

They are licensed under Creative Commons Attribution-NonCommercial-ShareAlike
4.0 International (https://creativecommons.org/licenses/by-nc-sa/4.0/), per
the project's model card. They are used unmodified, in a personal,
non-commercial app. openWakeWord's code is Apache 2.0; the TypeScript port of
its feature pipeline is in `src/core/wakeWord.ts`.

Selling this app would require replacing these models, for example with one
trained using openWakeWord's own training tools.
