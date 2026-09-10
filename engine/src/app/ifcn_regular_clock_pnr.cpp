#include <autopr/algorithms/genetic.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
#include <sstream>
#include <stdexcept>

namespace {
using namespace fcngraph;
std::string quote(const std::string& text) {
    std::ostringstream out; out << '"';
    for (unsigned char c : text) {
        if (c=='"' || c=='\\') out << '\\' << c;
        else if (c=='\n') out << "\\n";
        else if (c=='\r') out << "\\r";
        else if (c=='\t') out << "\\t";
        else if (c<32) throw std::runtime_error("control character in identifier");
        else out << c;
    }
    return out.str()+'"';
}
std::uint64_t integer(const std::string& value) {
    if (value.empty() || value.find_first_not_of("0123456789")!=std::string::npos)
        throw std::invalid_argument("expected unsigned integer");
    std::size_t used=0; const auto result=std::stoull(value,&used);
    if(used!=value.size()) throw std::invalid_argument("invalid integer");
    return result;
}
void snapshot(const std::filesystem::path& output, Parse& parse, GridChessboard& board,
              const Individual& candidate, const std::string& clock, const GeneticOptions& options,
              const GeneticAlgorithm& ga, double elapsed) {
    const auto& check=candidate.evaluation;
    std::ofstream out(output); if(!out) throw std::runtime_error("cannot write candidate JSON");
    out << "{\"schema\":\"ifcn.native_candidate.v1\",\"algorithm\":\"regular_clock_ga\",\"clock_scheme\":" << quote(clock)
        << ",\"clock_origin\":[0,0],\"routed\":" << (check.valid?"true":"false")
        << ",\"native_mapping_valid\":" << (check.valid?"true":"false")
        << ",\"regular_clock_valid\":" << (check.valid?"true":"false")
        << ",\"synchronization_valid\":" << (check.valid?"true":"false")
        << ",\"native_validation_error\":" << quote(check.valid?"":ga.lastError()) << ",\"run_time_s\":" << elapsed
        << ",\"seed\":" << options.seed << ",\"objective\":\"physical_area_then_mapped_cells\""
        << ",\"search\":{\"evaluated\":" << ga.evaluated() << ",\"feasible\":" << ga.feasible()
        << ",\"population\":" << options.population << ",\"generations\":" << options.generations
        << ",\"budget_s\":" << options.budget_seconds << "},\"regular_validation\":{\"passed\":" << (check.valid?"true":"false")
        << ",\"contract\":\"exact_routes_ports_mapping_template_plus_one_and_same_cycle_reconvergence\""
        << ",\"input_launch\":\"cycle_zero_at_template_phase\",\"arrival_ticks\":{";
    bool first=true;
    for(auto [node,tick]:check.arrival_ticks){if(!first)out<<',';first=false;out<<quote(std::to_string(node))<<':'<<tick;}
    out << "}},\"mapped_qca_cells\":" << check.mapped_cells << ",\"physical_area\":" << check.physical_area
        << ",\"cell_count_basis\":\"unique_xy_layer_sites\",\"area_tiles\":" << check.tile_area << ",\"layers\":[";
    first=true;
    for(const auto& layer:parse.getlayerNodeDivVec()) {
        if(!first)out<<',';first=false;out<<'[';bool firstNode=true;
        for(auto node:layer){if(!firstNode)out<<',';firstNode=false;out<<node;}out<<']';
    }
    out << "],\"nodes\":[";first=true;
    for(const auto& [id,p]:candidate.nodeindex_pos) {
        if(!first)out<<',';first=false;
        out << "{\"id\":" << id << ",\"name\":" << quote(parse.getNodeName(id)) << ",\"type\":" << quote(parse.getNodeType(id))
            << ",\"is_input\":" << (parse.getNodeType(id)=="input"?"true":"false")
            << ",\"is_output\":" << (parse.getOutputNodesIndex().count(id)?"true":"false")
            << ",\"x\":" << p.first << ",\"y\":" << p.second << '}';
    }
    out << "],\"edges\":[";first=true;
    for(auto edge:parse.getEffectiveEdges()){if(!first)out<<',';first=false;out<<'['<<edge.first<<','<<edge.second<<']';}
    out << "],\"routes\":[";first=true;std::set<position> used;
    for(auto [id,p]:candidate.nodeindex_pos)used.insert(p);
    for(const auto& [edge,path]:candidate.routes) {
        if(!first)out<<',';first=false;
        out << "{\"source\":" << edge.first << ",\"target\":" << edge.second << ",\"path\":[";
        bool firstPoint=true;
        for(auto p:path){if(!firstPoint)out<<',';firstPoint=false;out<<'['<<p.first<<','<<p.second<<']';used.insert(p);}out<<"]}";
    }
    out << "],\"cells\":[";first=true;
    for(auto p:used){if(!first)out<<',';first=false;out<<"{\"x\":"<<p.first<<",\"y\":"<<p.second<<",\"phase\":"
        << static_cast<int>(board.getCoorPos_Phase(p.first,p.second))<<'}';}
    out << "],\"expansion\":{\"inserted_rows\":0,\"inserted_columns\":0,\"accepted_rounds\":0}}\n";
    if(!out)throw std::runtime_error("failed writing candidate JSON");
}
}

int main(int argc,char** argv) {
    try {
        if(argc<5){std::cerr<<"Usage: ifcn_regular_clock_pnr input.v candidate.json --clock 2DDWave|USE|RES [--seed N --budget SEC --width N --height N --generations N --population N]\n";return 2;}
        GeneticOptions options;std::string clock;unsigned int width=8,height=8;
        std::set<std::string> seen;
        for(int i=3;i<argc;i+=2) {
            if(i+1>=argc)throw std::invalid_argument("option requires a value");
            const std::string key=argv[i],value=argv[i+1];
            if(!seen.insert(key).second)throw std::invalid_argument("duplicate option: "+key);
            if(key=="--clock")clock=value;
            else if(key=="--seed")options.seed=integer(value);
            else if(key=="--budget"){std::size_t used=0;options.budget_seconds=std::stod(value,&used);if(used!=value.size())throw std::invalid_argument("invalid budget");}
            else if(key=="--width" || key=="--height") {
                const auto size=integer(value);if(size<1 || size>128)throw std::invalid_argument("grid dimension must be 1..128");
                if(key=="--width")width=size;else height=size;
            }
            else if(key=="--generations")options.generations=integer(value);
            else if(key=="--population")options.population=integer(value);
            else throw std::invalid_argument("unknown option: "+key);
        }
        CLOCK_SCHEME scheme;
        if(clock=="2DDWave")scheme=CLOCK_SCHEME::TDD;
        else if(clock=="USE")scheme=CLOCK_SCHEME::USE;
        else if(clock=="RES")scheme=CLOCK_SCHEME::RES;
        else throw std::invalid_argument("clock must be exactly 2DDWave, USE, or RES");
        if(!std::isfinite(options.budget_seconds) || options.budget_seconds<=0 || options.budget_seconds>300)
            throw std::invalid_argument("budget must be in (0,300] seconds");
        if(!std::filesystem::is_regular_file(argv[1]))throw std::invalid_argument("input Verilog file is unavailable");
        Parse parse;parse.parseVerilog(argv[1]);
        if(!parse.get_input_num() || !parse.get_output_num())throw std::invalid_argument("primary inputs and outputs required");
        // effectiveNodes is populated by optimizeBufferNode(), not by parseVerilog().
        std::size_t gates=0;for(unsigned int id=0;id<parse.getm_numVertices();++id)if(parse.getNodeType(id)!="input")++gates;
        if(gates>50)throw std::invalid_argument("regular GA currently limits the source DAG to 50 gate nodes");
        parse.optimizeAIOG_DRC(2,2,2,2,2,2);parse.optimizeBufferNode();parse.caculateSameLayerNodeRoutePair();
        GridChessboard board(scheme,{0,0},{width,height});
        Astar router(board,true,static_cast<double>(width)*height*2);
        router.setAllowInterSourceWireOverlap(false);
        GeneticAlgorithm ga(parse,board,router,options);
        const auto start=std::chrono::steady_clock::now();const bool found=ga.gaRun();
        Individual best=ga.best();
        if(found)best.evaluation=validateRegularCandidate(parse,board,best.nodeindex_pos,best.routes);
        const double elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
        snapshot(argv[2],parse,board,best,clock,options,ga,elapsed);
        if(!found || !best.evaluation.valid){std::cerr<<"No strictly legal regular-clock candidate: "<<ga.lastError()<<'\n';return 10;}
        std::cout<<"IFCN_NATIVE_CANDIDATE_READY\n";return 0;
    } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
