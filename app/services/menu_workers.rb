module MenuWorkers
  extend self
  @lock=Monitor.new
  @signal=@lock.new_cond
  @active={}
  @failures={}
  @reads=Set.new
  def active(id) = @lock.synchronize { Array(@active[id]&.to_a).sort }
  def wake = @lock.synchronize { @signal.broadcast }
  def slots(name,default,maximum)
    value=ENV[name].to_i
    value.between?(1,maximum) ? value : default
  end
  def start
    return unless Store.ready? && ENV["MENU_WORKERS"]!="off"
    Store.transaction do
      Draft.where(state:"uploading").delete_all
      Draft.where(state:"reading").update_all(state:"waiting")
      Menu.where(state:"running").update_all(state:"queued")
      Store.sql("UPDATE generation_calls SET state='interrupted' WHERE state='running'")
    end
    @next_expiry=Time.now+3600
    @supervisor=Thread.new do
      loop do
        begin
          Rails.application.executor.wrap { schedule }
        rescue StandardError => e
          Rails.logger.error("Menu scheduler failed (#{e.class})")
        end
        @lock.synchronize { @signal.wait(0.12) }
      end
    end
    @janitor=Thread.new do
      loop do
        begin
          Rails.application.executor.wrap { cleanup }
        rescue StandardError => e
          Rails.logger.warn("Object cleanup deferred (#{e.class})")
        end
        sleep(ENV["RAILS_ENV"]=="test" ? 0.15 : 15)
      end
    end
  end
  def cleanup
    if !@next_expiry || Time.now>=@next_expiry
      @next_expiry=Time.now+3600
      Store.transaction do
        %w[admin_sessions counters sessions].each { |t| Store.sql("DELETE FROM #{t} WHERE expires<=?",Store.now) }
        stale=Menu.where(state:%w[error credit_paused]).where("created<? AND NOT EXISTS (SELECT 1 FROM dish_objects WHERE menu_id=menus.id)",7.days.ago.utc.iso8601)
        stale.each do |menu|
          Array(menu.content["originals"]).each { |k| Store.sql("INSERT OR IGNORE INTO object_cleanup VALUES(?)",k) }
          menu.delete
        end
      end
    end
    Store.sql("SELECT key FROM object_cleanup LIMIT 30").each do |row|
      Objects.request(row["key"],method: :delete)
      Store.sql("DELETE FROM object_cleanup WHERE key=?",row["key"])
    end
  end
  def schedule
    @lock.synchronize do
      free=slots("MENU_READ_CONCURRENCY",2,3)-@reads.size
      if free.positive?
        Draft.joins(:submission_session).where(state:"waiting").where("sessions.expires>?",Store.now).order("drafts.rowid").limit(free).pluck(:id).each do |id|
          next unless Draft.where(id:id,state:"waiting").update_all(state:"reading")==1
          @reads.add(id)
          Thread.new(id) do |job|
            begin
              Rails.application.executor.wrap { ReadMenuJob.perform_now(job) }
            ensure
              @lock.synchronize { @reads.delete(job); @signal.broadcast }
            end
          end
        end
      end
      menus=Menu.where(state:%w[queued running]).order(:created,:id).to_a
      saved={}
      free=slots("MENU_IMAGE_CONCURRENCY",4,8)-@active.values.sum(&:size)
      free.times do
        if (last=menus.index { |m| m.id==@last })
          menus=menus.rotate(last+1)
        end
        finished=[]
        chosen=nil
        menus.each do |m|
          next if @failures.key?(m.id)
          current=@active[m.id] ||= Set.new
          done=saved[m.id] ||= m.positions.to_set
          pos=(0...m.content["dishes"].size).find { |i| !done.include?(i) && !current.include?(i) }
          if pos
            chosen=[m,pos]
            break
          elsif current.empty?
            finish(m.id,"complete")
            finished << m.id
          end
        end
        menus.reject! { |m| finished.include?(m.id) }
        break unless chosen
        menu,pos=chosen
        @last=menu.id
        @active[menu.id].add(pos)
        menu.update!(state:"running") unless menu.state=="running"
        ProgressEvents.publish(menu.id)
        Thread.new(menu.id,pos) { |id,i| illustrate(id,i) }
      end
    end
  end
  def finish(id,state)
    fields = {state: state}
    fields[:created] = Store.stamp if state == "complete"
    Menu.where(id:id).update_all(fields)
    @active.delete(id)
    @failures.delete(id)
    ProgressEvents.publish(id)
  end
  def illustrate(id,i)
    failure=nil
    begin
      Rails.application.executor.wrap { IllustrateDishJob.perform_now(id,i) }
    rescue BillingBalance::Paused
      failure="credit_paused"
    rescue StandardError => e
      failure="error"
      Rails.logger.warn("Dish generation failed (#{e.class})")
    ensure
      Rails.application.executor.wrap do
        @lock.synchronize do
          @active.fetch(id).delete(i)
          # A genuine generation error still counts when another dish was paused.
          @failures[id] = failure if failure && @failures[id] != "error"
          finish(id,@failures[id]) if @failures.key?(id) && @active[id].empty?
          ProgressEvents.publish(id)
          @signal.broadcast
        end
      end
    end
  end
end
