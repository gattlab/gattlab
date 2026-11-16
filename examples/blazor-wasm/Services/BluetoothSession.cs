using Microsoft.JSInterop;

namespace GattLab.BlazorSample.Services;

/// <summary>
/// C# owner of one JavaScript session. Every result and callback carries the
/// session id the JavaScript side stored, and is logged against this owner.
/// </summary>
public sealed class BluetoothSession : IAsyncDisposable
{
    private readonly LifecycleLog log;
    private IJSObjectReference? session;
    private Task pending = Task.CompletedTask;
    private bool disposed;

    internal BluetoothSession(LifecycleLog log, int id)
    {
        this.log = log;
        Id = id;
        Receiver = DotNetObjectReference.Create(this);
    }

    public int Id { get; }

    internal DotNetObjectReference<BluetoothSession> Receiver { get; }

    public event Func<Task>? Disconnected;

    internal void Attach(IJSObjectReference reference) => session = reference;

    /// <summary>
    /// Starts <paramref name="method"/> synchronously (no await precedes the
    /// JavaScript call, which keeps the click gesture for the chooser). Returns
    /// null when this session was disposed before the result arrived.
    /// </summary>
    public async Task<BluetoothResult?> InvokeAsync(string action, string method)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (session is null) throw new InvalidOperationException("Bluetooth session is not ready.");
        log.Add($"request {Id} {action}");
        var call = session.InvokeAsync<BluetoothResult>(method).AsTask();
        pending = call;
        BluetoothResult result;
        try
        {
            result = await call;
        }
        catch (Exception error) when (disposed)
        {
            // JavaScript settles every action as a value; a released owner still records a rejection.
            log.Add($"late-result {Id} {error.GetType().Name}");
            return null;
        }
        if (result.SessionId != Id) log.Add($"session-mismatch {Id} {result.SessionId}");
        if (disposed)
        {
            log.Add(result.Disposed ? $"settled {Id} disposed" : $"late-result {Id} {result.Kind}");
            return null;
        }
        log.Add($"result {Id} {result.Kind}");
        return result;
    }

    [JSInvokable]
    public async Task OnDisconnected(int sessionId)
    {
        if (sessionId != Id) log.Add($"session-mismatch {Id} {sessionId}");
        if (disposed)
        {
            log.Add($"late-callback {Id} disconnected");
            return;
        }
        log.Add($"callback {Id} disconnected");
        if (Disconnected is not null) await Disconnected.Invoke();
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        Disconnected = null;
        // Recorded before JavaScript release, so an event raised by the release is late.
        log.MarkDisposed(Id);
        if (session is null)
        {
            Receiver.Dispose();
            return;
        }
        try
        {
            await session.InvokeVoidAsync("dispose");
        }
        finally
        {
            _ = ReleaseAfterPendingAsync(session);
        }
    }

    private async Task ReleaseAfterPendingAsync(IJSObjectReference reference)
    {
        // The in-flight call settles as `disposed` once its native prompt or
        // operation ends; only then are the JavaScript object and receiver freed.
        try
        {
            await pending;
        }
        catch
        {
            // The awaiting action reports its own failure.
        }
        try
        {
            await reference.DisposeAsync();
        }
        catch (JSDisconnectedException)
        {
            // The page is gone; nothing remains to release.
        }
        finally
        {
            Receiver.Dispose();
        }
    }
}
