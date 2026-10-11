# Bundled QR encoder

Unmodified MIT-licensed source from **Net.Codecrete.QrCodeGenerator v1.6.1**,
the C# port of Project Nayuki's QR Code generator:
https://github.com/manuelbl/QrCodeGenerator/tree/v1.6.1
Exact upstream commit: `871a390fc841b39ba020a2a6de11518be6850093`.

Copyright notices are retained in every source file; see LICENSE.
RAP uses only its standard text encoder and bitmap renderer. No package install,
external service, native binary or network request is involved in QR generation.

GUI.ps1 lowers `nameof`, getter-only properties, numeric separators and the five
interpolated strings to equivalent C#5 syntax **in memory** for Windows PowerShell 5.1's
built-in compiler. The advanced segmentation source is retained for provenance
but not compiled or used. The QR algorithm is unchanged.
