class ReadMenuJob < ActiveJob::Base
  def perform(id)
    draft=Draft.find(id)
    pages=draft.page_keys.map { |key| "data:image/jpeg;base64,"+Base64.strict_encode64(Objects.request(key)) }
    model,effort=Settings.current.values_at("readingModel","reasoning")
    result=GenerationHistory.measure(id,"read","Menu transcription",model,effort,draft.read_ip) { |usage| Providers.read(pages,model,effort,usage) }
    raise Problem.new(422,"These photos could not be recognised as a restaurant menu.") unless result["isMenu"]
    if result["dishes"].present? && result["dishes"].all? { |d| d["hasDishPhoto"]==true }
      Store.transaction do
        draft.page_keys.each { |key| Store.sql("INSERT OR IGNORE INTO object_cleanup VALUES(?)",key) }
        draft.update!(state:"already_illustrated",pages:"[]",error:"Every dish on this menu already has a photo. No dish illustrations were generated.")
      end
    elsif draft.submission_session.info["autoPublish"]
      Submissions.enqueue(draft,result,draft.read_ip)
    else
      draft.update!(state:"review",result:result.to_json)
    end
  rescue BillingBalance::Paused => e
    Draft.where(id:id).update_all(state:"read_paused",error:e.message)
  rescue StandardError => e
    Draft.where(id:id).update_all(state:"read_error",error:e.is_a?(Problem) ? e.message : "The menu could not be read. Try again with a clear photo.")
    Rails.logger.warn("Menu reading failed (#{e.class})")
  end
end
