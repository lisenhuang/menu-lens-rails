class EventsController < ApplicationController
  include ActionController::Live
  def show
    id=params[:id]
    owner=job_owner
    initial=JobStatus.fetch(id,owner)
    queue=ProgressEvents.listen(id,owner)
    response.headers.merge!("Content-Type"=>"text/event-stream","Cache-Control"=>"private, no-store, no-transform","X-Accel-Buffering"=>"no","Vary"=>"Cookie","Last-Modified"=>Time.now.httpdate)
    current=initial
    last=nil
    loop do
      data=current.to_json
      if data!=last
        if params[:view]=="turbo"
          menu=Menu.find_by(id:id)&.public_view
          if menu
            html=render_to_string(partial:"menus/content",formats:[:html],locals:{menu:menu,can_retry:current[:canRetry]})
            frame=turbo_stream.replace("visual-menu",html.html_safe,method: :morph).to_s
            response.stream.write(frame.lines.map { |line| "data: "+line.chomp }.join("\n")+"\n\n")
          end
        else
          response.stream.write("data: #{data}\n\n")
        end
      end
      last=data
      break unless %w[uploading waiting reading queued running].include?(current[:state]) || (current[:state]=="error" && current[:completed].to_i>0)
      current=queue.pop(timeout:1)
      unless current
        response.stream.write(": heartbeat\n\n")
        current=JobStatus.fetch(id,owner)
      end
    end
  rescue IOError, ActionController::Live::ClientDisconnected
    nil
  ensure
    if queue
      ProgressEvents.remove(id,queue)
      response.stream.close
    end
  end
end
