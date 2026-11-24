module ProgressEvents
  extend self
  @mutex=Mutex.new
  @listeners=Hash.new { |h,k| h[k]=[] }
  def listen(id,owner)
    queue=SizedQueue.new(64)
    @mutex.synchronize do
      raise Problem.new(429,"Live updates are busy.") if @listeners.values.sum(&:length)>=20 || @listeners[id].size>=12
      @listeners[id]<<[queue,owner]
    end
    queue
  end
  def remove(id,queue)
    @mutex.synchronize do
      @listeners[id].reject! { |q,_| q==queue }
      @listeners.delete(id) if @listeners[id].empty?
    end
  end
  def publish(id)
    listeners=@mutex.synchronize { @listeners.fetch(id,[]).dup }
    listeners.each do |queue,owner|
      queue.push(JobStatus.fetch(id,owner),true)
    rescue ThreadError,Problem
      # A slow viewer receives a fresh snapshot on its next heartbeat.
    end
  end
end
