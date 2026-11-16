using Microsoft.JSInterop;

namespace GattLab.BlazorSample.Services;

/// <summary>
/// Page-lifetime diagnostics rendered by Razor. It outlives every panel, so a
/// result, callback, or native event that reaches a released session is
/// classified as late instead of disappearing with its owner.
/// </summary>
public sealed class LifecycleLog : IDisposable
{
    private readonly List<string> entries = [];
    private readonly HashSet<int> disposedSessions = [];
    private DotNetObjectReference<LifecycleLog>? reference;
    private int lastSessionId;

    public event Action? Changed;

    public IReadOnlyList<string> Entries => entries;

    public DotNetObjectReference<LifecycleLog> Reference => reference ??= DotNetObjectReference.Create(this);

    public int CreateSession()
    {
        var id = ++lastSessionId;
        Add($"created {id}");
        return id;
    }

    public void MarkDisposed(int sessionId)
    {
        disposedSessions.Add(sessionId);
        Add($"disposed {sessionId}");
    }

    public bool IsDisposed(int sessionId) => disposedSessions.Contains(sessionId);

    public void Add(string entry)
    {
        entries.Add(entry);
        Changed?.Invoke();
    }

    [JSInvokable]
    public void OnNativeEvent(int sessionId, string type) =>
        Add($"{(IsDisposed(sessionId) ? "late-native-event" : "native-event")} {sessionId} {type}");

    public void Dispose()
    {
        reference?.Dispose();
        reference = null;
    }
}
