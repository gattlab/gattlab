namespace GattLab.BlazorSample.Services;

public sealed class BluetoothResult
{
    public int SessionId { get; set; }
    public bool Success { get; set; }
    public bool Disposed { get; set; }
    public bool? Available { get; set; }
    public int? Battery { get; set; }
    public int[] Written { get; set; } = [];
    public string? FailedStep { get; set; }
    public BluetoothError? Error { get; set; }

    public string Kind =>
        Disposed ? "disposed"
        : Success ? "success"
        : FailedStep is { } step ? $"{step}-error"
        : $"{Error?.Category ?? "interop"}-error";
}

public sealed class BluetoothError
{
    public string Category { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Message { get; set; } = string.Empty;
}
